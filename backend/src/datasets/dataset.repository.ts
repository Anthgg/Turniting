import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

/** Persistence for dataset versions, sources, artifacts, split manifests and samples. */
@Injectable()
export class DatasetRepository {
  constructor(private readonly prisma: PrismaService) {}

  findVersionByNameVersion(name: string, version: string) {
    return this.prisma.datasetVersion.findUnique({ where: { name_version: { name, version } } });
  }

  findVersion(id: string) {
    return this.prisma.datasetVersion.findUnique({
      where: { id },
      include: {
        splitManifests: { orderBy: { rowCount: 'desc' } },
        modelVersions: { orderBy: { createdAt: 'asc' } },
        _count: { select: { sources: true, artifacts: true, samples: true } },
      },
    });
  }

  async listVersions(page: number, limit: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.datasetVersion.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          sources: { select: { name: true, status: true, licenseStatus: true, commercialUseStatus: true } },
          _count: { select: { sources: true, modelVersions: true, samples: true } },
        },
      }),
      this.prisma.datasetVersion.count(),
    ]);
    return { items, total };
  }

  createVersion(data: Prisma.DatasetVersionCreateInput) {
    return this.prisma.datasetVersion.create({ data });
  }

  listSources(datasetVersionId: string) {
    return this.prisma.datasetSource.findMany({ where: { datasetVersionId }, orderBy: { name: 'asc' } });
  }

  listArtifacts(datasetVersionId: string) {
    return this.prisma.datasetArtifact.findMany({
      where: { OR: [{ datasetVersionId }, { modelVersion: { datasetVersionId } }] },
      orderBy: [{ artifactType: 'asc' }, { path: 'asc' }],
    });
  }

  async listSamples(where: Prisma.TrainingSampleWhereInput, page: number, limit: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.trainingSample.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.trainingSample.count({ where }),
    ]);
    return { items, total };
  }

  /** Replace sources, split manifests and dataset artifacts and update the version atomically. */
  replaceManifestData(
    id: string,
    version: Prisma.DatasetVersionUpdateInput,
    sources: Prisma.DatasetSourceCreateManyInput[],
    splits: Prisma.TrainingSplitManifestCreateManyInput[],
    artifacts: Prisma.DatasetArtifactCreateManyInput[],
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.datasetArtifact.deleteMany({ where: { datasetVersionId: id } });
      await tx.trainingSplitManifest.deleteMany({ where: { datasetVersionId: id } });
      // Sources referenced by samples keep their ids: upsert by (version, name).
      for (const source of sources) {
        const { datasetVersionId: _ignored, ...data } = source;
        await tx.datasetSource.upsert({
          where: { datasetVersionId_name: { datasetVersionId: id, name: source.name } },
          create: { ...data, datasetVersion: { connect: { id } } },
          update: data,
        });
      }
      await tx.datasetSource.deleteMany({
        where: { datasetVersionId: id, name: { notIn: sources.map((s) => s.name) }, samples: { none: {} } },
      });
      if (splits.length) await tx.trainingSplitManifest.createMany({ data: splits });
      if (artifacts.length) await tx.datasetArtifact.createMany({ data: artifacts });
      return tx.datasetVersion.update({ where: { id }, data: version });
    });
  }
}
