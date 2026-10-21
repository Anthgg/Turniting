import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@tanstack/react-query", () => queryMocks);

import { ReportExportPanel } from "./ReportExportPanel";

const DOCUMENT_ID = "66b2f3c5-14df-4156-a1df-152a7129f88e";
const VERSION_ID = "8edee971-57eb-478b-b811-5f83b8115ea3";
const RUN_ID = "31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4";
const REPORT_ID = "e564fa70-4188-4e8e-a4eb-98fda94f8865";

function analysisResult(status: "COMPLETED" | "RUNNING" = "COMPLETED") {
  return {
    data: {
      items: [
        {
          id: RUN_ID,
          status,
          createdAt: "2026-10-18T12:00:00.000Z",
          completedAt:
            status === "COMPLETED" ? "2026-10-18T12:00:01.000Z" : null,
          analyzerMode: "V3_ONLY",
          paragraphMode: "STRICT_PARAGRAPH",
          documentScore: 0.434,
          threshold: 0.59,
        },
      ],
    },
    isPending: false,
    isError: false,
    error: null,
  };
}

function artifact(
  status: "GENERATING" | "AVAILABLE" | "FAILED" | "EXPIRED" | "DELETED" = "AVAILABLE",
  type: "AI_REPORT" | "AI_ORIGINAL_REVIEW" | "AI_PARAGRAPH_TECHNICAL" = "AI_REPORT",
) {
  return {
    id: REPORT_ID,
    documentId: DOCUMENT_ID,
    documentVersionId: VERSION_ID,
    analysisRunId: RUN_ID,
    similarityRunId: null,
    type,
    status,
    filename: type === "AI_ORIGINAL_REVIEW"
      ? "turniting_original-review_66b2f3c5_2026-10-18.pdf"
      : type === "AI_PARAGRAPH_TECHNICAL"
        ? "turniting_paragraph-technical_66b2f3c5_2026-10-18.pdf"
        : "turniting_ai_66b2f3c5_2026-10-18.pdf",
    contentHash: "b".repeat(64),
    sizeBytes: 1024 * 486,
    failureReason: status === "FAILED" ? "No se pudo generar el PDF. Intenta de nuevo." : null,
    generationVersion: "f0091-report-renderer-v2",
    run: { id: RUN_ID, globalScore: 0.434, threshold: 0.59, modelNames: ["SYNTHETIC"], analyzerMode: "V3_ONLY" },
    generatedAt: "2026-10-18T12:00:00.000Z",
    expiresAt: "2026-10-19T12:00:00.000Z",
    deletedAt: null,
  };
}

function renderPanel({
  runStatus = "COMPLETED",
  reportStatus,
  reportTypes,
  generatePending = false,
  downloadPending = false,
}: {
  runStatus?: "COMPLETED" | "RUNNING";
  reportStatus?: "GENERATING" | "AVAILABLE" | "FAILED" | "EXPIRED" | "DELETED";
  reportTypes?: Array<"AI_REPORT" | "AI_ORIGINAL_REVIEW" | "AI_PARAGRAPH_TECHNICAL">;
  generatePending?: boolean;
  downloadPending?: boolean;
} = {}) {
  queryMocks.useQuery.mockImplementation(({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[0] !== "reports" ? analysisResult(runStatus) : {
      data: {
        items: reportStatus
          ? (reportTypes ?? ["AI_REPORT"]).map((type) => artifact(reportStatus, type))
          : [],
      },
      isPending: false,
      isError: false,
      error: null,
    });
  let mutationIndex = 0;
  const mutations = [
    {
      isPending: generatePending,
      isError: false,
      error: null,
      mutate: vi.fn(),
    },
    {
      isPending: downloadPending,
      variables: downloadPending ? artifact("AVAILABLE") : undefined,
      isError: false,
      error: null,
      mutate: vi.fn(),
    },
    { isPending: false, isError: false, mutate: vi.fn() },
    { isPending: false, isError: false, mutate: vi.fn() },
    { isPending: false, isError: false, mutate: vi.fn() },
  ];
  queryMocks.useMutation.mockImplementation(() => mutations[mutationIndex++ % mutations.length]);
  return renderToStaticMarkup(
    createElement(ReportExportPanel, {
      documentId: DOCUMENT_ID,
      canExport: true,
    }),
  );
}

describe("ReportExportPanel", () => {
  beforeEach(() => {
    queryMocks.useQuery.mockReset();
    queryMocks.useMutation.mockReset();
    queryMocks.useQueryClient.mockClear();
  });

  it("offers both AI report variants when a completed analysis exists and keeps similarity disabled", () => {
    const html = renderPanel();

    expect(html).toContain("Generar revisión original");
    expect(html).toContain("Generar detalle por párrafos");
    expect(html).toContain("Generar ambos reportes");
    expect(html).toContain("resalta los segmentos evaluados que cumplen el criterio de revisión visual");
    expect(html).toContain("independiente del umbral del detector");
    expect(html).not.toContain("alcanzan el umbral aplicado");
    expect(html).toContain(
      "Aún no existe un análisis de similitud para esta versión.",
    );
    expect(html).toContain('disabled=""');
  });

  it("shows the 24-hour availability and localized expiry for an available artifact", () => {
    const html = renderPanel({ reportStatus: "AVAILABLE" });

    expect(html).toContain("Disponible por 24 h");
    expect(html).toContain("Expira:");
    expect(html).toContain("Descargar reporte ia anterior");
    expect(html).toContain("Ver reporte ia anterior");
    expect(html).toContain("Reporte IA anterior");
    expect(html).toContain("Eliminar");
    expect(html).toContain("486 KB");
  });

  it("shows the generation state while the report is being prepared", () => {
    const html = renderPanel({
      reportStatus: "GENERATING",
      generatePending: true,
    });

    expect(html).toContain("Generando…");
    expect(html).toContain("is-generating");
  });

  it("offers regeneration for an expired report and shows the download state", () => {
    const html = renderPanel({
      reportStatus: "EXPIRED",
      reportTypes: ["AI_ORIGINAL_REVIEW"],
    });

    expect(html).toContain("Regenerar revisión original");
    expect(html).toContain("Expirado");
    expect(html).toContain("Regenerar");

    queryMocks.useQuery.mockReset();
    queryMocks.useMutation.mockReset();
    const downloadHtml = renderPanel({
      reportStatus: "AVAILABLE",
      downloadPending: true,
    });
    expect(downloadHtml).toContain("Descargando…");
  });

  it("shows a sanitized retry state for failed report generation", () => {
    const html = renderPanel({
      reportStatus: "FAILED",
      reportTypes: ["AI_ORIGINAL_REVIEW"],
    });

    expect(html).toContain("Error al generar");
    expect(html).toContain("No se pudo generar el PDF. Intenta de nuevo.");
    expect(html).toContain("Regenerar revisión original");
  });

  it("does not enable export while there is no completed run", () => {
    const html = renderPanel({ runStatus: "RUNNING" });

    expect(html).toContain(
      "Completa un análisis de IA para habilitar su reporte.",
    );
    expect(html).toContain('disabled=""');
  });

  it("keeps the original-review and technical report controls distinct", () => {
    const html = renderPanel({
      reportStatus: "AVAILABLE",
      reportTypes: ["AI_ORIGINAL_REVIEW", "AI_PARAGRAPH_TECHNICAL"],
    });

    expect(html).toContain("Ver revisión original");
    expect(html).toContain("Descargar revisión original");
    expect(html).toContain("Ver detalle por párrafos");
    expect(html).toContain("Descargar detalle por párrafos");
    expect(html).toContain("Revisión original");
    expect(html).toContain("Detalle por párrafos");
    expect(html).toContain("Regenerar revisión original");
    expect(html).toContain("Regenerar detalle por párrafos");
    expect(html.match(/43\.4 %/g)).toHaveLength(5);
    expect(html.match(/59\.0 %/g)).toHaveLength(3);
    expect(html).toContain(`data-analysis-run-id="${RUN_ID}"`);
  });
});
