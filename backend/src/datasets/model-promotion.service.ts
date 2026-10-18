import { Injectable } from '@nestjs/common';
import { ModelStatus } from '@prisma/client';
import {
  ACTIVE_ACCEPTANCE_LIMITS,
  MODEL_CATALOG,
  numericGateResults,
} from '../analysis/model-catalog.js';

export type ModelPromotionReview = {
  approved: boolean;
  reviewer: string;
  reviewedAt: string;
  rationale: string;
};

type GateState = 'PASS' | 'FAIL' | 'NOT_EVALUATED';

type PromotionCriterion = {
  state: GateState;
  observed?: number | boolean | string | null;
  limit?: number;
};

@Injectable()
export class ModelPromotionService {
  evaluate(modelName: string, status: ModelStatus, review?: ModelPromotionReview) {
    const model = MODEL_CATALOG[modelName];
    const numeric = numericGateResults(model?.metrics ?? null);
    const criteria: Record<string, PromotionCriterion> = {};

    for (const [name, limit] of Object.entries(ACTIVE_ACCEPTANCE_LIMITS)) {
      const result = numeric?.[name as keyof typeof ACTIVE_ACCEPTANCE_LIMITS];
      criteria[name] = {
        state: result ? result.passed ? 'PASS' : 'FAIL' : 'NOT_EVALUATED',
        observed: result?.observed ?? null,
        limit,
      };
    }

    for (const [name, passed] of Object.entries(model?.officialGates ?? {})) {
      criteria[`official.${name}`] = {
        state: passed ? 'PASS' : 'FAIL',
        observed: passed,
      };
    }

    for (const [name, passed] of Object.entries(model?.promotionEvidence ?? {})) {
      criteria[name] = {
        state: passed === null ? 'NOT_EVALUATED' : passed ? 'PASS' : 'FAIL',
        observed: passed,
      };
    }

    const reviewIsExplicit = Boolean(
      review?.approved === true
      && review.reviewer.trim()
      && review.rationale.trim()
      && Number.isFinite(Date.parse(review.reviewedAt)),
    );
    criteria.explicitReview = {
      state: reviewIsExplicit ? 'PASS' : review?.approved === false ? 'FAIL' : 'NOT_EVALUATED',
      observed: reviewIsExplicit,
    };
    criteria.modelStatus = {
      state: status === ModelStatus.CANDIDATE || status === ModelStatus.EXPERIMENTAL ? 'PASS' : 'FAIL',
      observed: status,
    };

    const blockers = Object.entries(criteria)
      .filter(([, criterion]) => criterion.state !== 'PASS')
      .map(([name]) => name);
    if (!model) blockers.push('modelEvidence');

    return {
      model: modelName,
      decision: blockers.length === 0 ? 'ELIGIBLE' as const : 'BLOCKED' as const,
      eligible: blockers.length === 0,
      reviewRequired: true as const,
      criteria,
      blockers: [...new Set(blockers)],
    };
  }
}
