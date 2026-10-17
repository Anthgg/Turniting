import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  GroundTruthCaseType,
  LabelSource,
  Prisma,
  PrivacyClass,
  TrainingLabel,
  TurnitinReportType,
  TurnitinSegmentType,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

/** Cases reserved for blind external comparison never enter any dataset. */
const RESERVED_CASE_PATTERN = /^VALIDATION_CASE_/i;
export const GROUND_TRUTH_IMPORT_VERSION = 'f004-v1';

export function sampleTextHash(text: string): string {
  const normalized = text.normalize('NFC').replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Turns Turnitin AI ground truth into candidate TrainingSamples.
 *
 * - AI_FLAGGED segments -> MACHINE candidates (labelSource TURNITIN_AI_FLAGGED, PRIVATE).
 * - NOT_FLAGGED segments are NOT converted to HUMAN: Turnitin not flagging a passage is
 *   not evidence of human authorship. They are counted and skipped.
 * - Similarity segments are never AI labels.
 * Re-importing is idempotent per (datasetVersion, turnitinSegment).
 */
@Injectable()
export class GroundTruthDatasetService {
  constructor(private readonly prisma: PrismaService) {}

  async importCase(datasetVersionId: string, caseId: string) {
    const dataset = await this.prisma.datasetVersion.findUnique({ where: { id: datasetVersionId } });
    if (!dataset) throw new NotFoundException('Dataset version not found');
    const groundTruth = await this.prisma.groundTruthCase.findUnique({
      where: { id: caseId },
      include: { aiReport: true },
    });
    if (!groundTruth) throw new NotFoundException('Ground truth case not found');
    if (RESERVED_CASE_PATTERN.test(groundTruth.name) || groundTruth.caseType === GroundTruthCaseType.VALIDATION) {
      throw new BadRequestException('Validation cases are reserved for blind comparison and cannot enter a dataset');
    }
    if (groundTruth.caseType !== GroundTruthCaseType.AI_REPORT || !groundTruth.aiReport) {
      throw new BadRequestException('Only AI_REPORT ground truth cases with a linked AI report can be imported');
    }
    if (groundTruth.aiReport.reportType !== TurnitinReportType.AI_WRITING) {
      throw new BadRequestException('The linked report is not a Turnitin AI writing report');
    }

    const segments = await this.prisma.turnitinSegment.findMany({
      where: { reportId: groundTruth.aiReport.id },
      orderBy: { segmentIndex: 'asc' },
      select: { id: true, segmentType: true, text: true, pageNumber: true, segmentIndex: true,
        documentStartOffset: true, documentEndOffset: true, alignmentScore: true },
    });
    const flagged = segments.filter((s) => s.segmentType === TurnitinSegmentType.AI_FLAGGED && s.text.trim().length > 0);
    const notFlagged = segments.filter((s) => s.segmentType === TurnitinSegmentType.NOT_FLAGGED).length;
    const other = segments.length - flagged.length - notFlagged;

    const data: Prisma.TrainingSampleCreateManyInput[] = flagged.map((segment) => ({
      datasetVersionId,
      documentVersionId: groundTruth.documentVersionId ?? groundTruth.aiReport?.documentVersionId ?? null,
      turnitinSegmentId: segment.id,
      groundTruthCaseId: groundTruth.id,
      text: segment.text,
      textHash: sampleTextHash(segment.text),
      label: TrainingLabel.MACHINE,
      labelSource: LabelSource.TURNITIN_AI_FLAGGED,
      eligibleForTraining: true,
      confidence: null,
      privacyClass: PrivacyClass.PRIVATE,
      metadata: {
        candidate: true,
        provenance: {
          importVersion: GROUND_TRUTH_IMPORT_VERSION,
          groundTruthCase: groundTruth.name,
          turnitinReportId: groundTruth.aiReport!.id,
          aiWritingScore: groundTruth.aiReport!.aiWritingScore,
          segmentIndex: segment.segmentIndex,
          pageNumber: segment.pageNumber,
          documentStartOffset: segment.documentStartOffset,
          documentEndOffset: segment.documentEndOffset,
          alignmentScore: segment.alignmentScore,
        },
        note: 'Turnitin AI_FLAGGED is a third-party signal, not verified authorship.',
      },
    }));

    const created = data.length
      ? await this.prisma.trainingSample.createMany({ data, skipDuplicates: true })
      : { count: 0 };
    return {
      datasetVersionId,
      groundTruthCaseId: groundTruth.id,
      aiFlaggedSegments: flagged.length,
      machineSamplesCreated: created.count,
      alreadyImported: flagged.length - created.count,
      notFlaggedSkipped: notFlagged,
      humanSamplesCreated: 0,
      otherSegmentsSkipped: other,
    };
  }
}
