#!/usr/bin/env node
// Export locally stored TrainingSamples of one DatasetVersion to JSONL for future training runs.
//
//   node scripts/export-training-samples.mjs --dataset <uuid> [--out ../training/datasets/cache/local_samples/<name>.jsonl]
//        [--eligible-only] [--include-private-text]
//
// Private (document-derived) text is exported only with --include-private-text, and the default
// output folder is git-ignored. The export is never merged automatically with public datasets.
import { PrismaClient } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = { eligibleOnly: false, includePrivateText: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--dataset') args.dataset = argv[++i];
    else if (key === '--out') args.out = argv[++i];
    else if (key === '--eligible-only') args.eligibleOnly = true;
    else if (key === '--include-private-text') args.includePrivateText = true;
    else throw new Error(`Unknown argument ${key}`);
  }
  if (!args.dataset || !/^[0-9a-f-]{36}$/i.test(args.dataset)) {
    throw new Error('--dataset <uuid> is required');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const dataset = await prisma.datasetVersion.findUnique({ where: { id: args.dataset } });
    if (!dataset) throw new Error('Dataset version not found');
    const samples = await prisma.trainingSample.findMany({
      where: { datasetVersionId: dataset.id, ...(args.eligibleOnly ? { eligibleForTraining: true } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    const out = path.resolve(args.out ?? `../training/datasets/cache/local_samples/${dataset.name}_${dataset.version}.jsonl`);
    await mkdir(path.dirname(out), { recursive: true });
    let privateRedacted = 0;
    const lines = samples.map((s) => {
      const exposeText = s.privacyClass !== 'PRIVATE' || args.includePrivateText;
      if (!exposeText) privateRedacted += 1;
      return JSON.stringify({
        id: s.id,
        text: exposeText ? s.text : null,
        textHash: s.textHash,
        label: s.label,
        labelSource: s.labelSource,
        language: s.language,
        domain: s.domain,
        generator: s.generator,
        split: s.split,
        eligibleForTraining: s.eligibleForTraining,
        confidence: s.confidence,
        privacyClass: s.privacyClass,
        groundTruthCaseId: s.groundTruthCaseId,
        turnitinSegmentId: s.turnitinSegmentId,
        dataset: `${dataset.name}_${dataset.version}`,
      });
    });
    await writeFile(out, lines.length ? `${lines.join('\n')}\n` : '', 'utf-8');
    process.stdout.write(`${JSON.stringify({ out, samples: samples.length, privateTextRedacted: privateRedacted })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
