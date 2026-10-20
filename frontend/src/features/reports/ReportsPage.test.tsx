import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@tanstack/react-query", () => queryMocks);
vi.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children?: ReactNode }) =>
    createElement("a", { href: to, ...props }, children),
}));

import { ReportsPage } from "./ReportsPage";
import { createReportHistoryQuery } from "./report-history-query";

const DOCUMENT_ID = "66b2f3c5-14df-4156-a1df-152a7129f88e";
const REPORT_ID = "e564fa70-4188-4e8e-a4eb-98fda94f8865";

function artifact(
  status: "AVAILABLE" | "EXPIRED" = "AVAILABLE",
  type: "AI_REPORT" | "AI_ORIGINAL_REVIEW" | "AI_PARAGRAPH_TECHNICAL" = "AI_ORIGINAL_REVIEW",
) {
  return {
    id: REPORT_ID,
    documentId: DOCUMENT_ID,
    documentVersionId: "8edee971-57eb-478b-b811-5f83b8115ea3",
    analysisRunId: "31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4",
    similarityRunId: null,
    type,
    status,
    filename: type === "AI_ORIGINAL_REVIEW"
      ? "turniting_original-review_66b2f3c5_2026-10-18.pdf"
      : type === "AI_PARAGRAPH_TECHNICAL"
        ? "turniting_paragraph-technical_66b2f3c5_2026-10-18.pdf"
        : "turniting_ai_66b2f3c5_2026-10-18.pdf",
    previewAvailable: status === "AVAILABLE",
    documentName: "muestra_sintetica.docx",
    runLabel: "31ec6f6f · V3_ONLY",
    run: { id: "31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4", globalScore: 0.434, threshold: 0.59, modelNames: ["SYNTHETIC"], analyzerMode: "V3_ONLY" },
    contentHash: "b".repeat(64),
    sizeBytes: 486 * 1024,
    failureReason: null,
    generationVersion: "f0091-report-renderer-v2",
    generatedAt: "2026-10-18T12:00:00.000Z",
    expiresAt:
      status === "AVAILABLE"
        ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
        : "2026-10-17T12:00:00.000Z",
    deletedAt: status === "EXPIRED" ? "2026-10-17T12:00:00.000Z" : null,
  };
}

function renderPage(status: "AVAILABLE" | "EXPIRED" = "AVAILABLE") {
  queryMocks.useQuery.mockReturnValue({
    data: { items: [artifact(status)], total: 1, page: 1, pageSize: 20 },
    isPending: false,
    isError: false,
  });
  queryMocks.useMutation
    .mockReturnValueOnce({ isPending: false, isError: false, mutate: vi.fn() })
    .mockReturnValueOnce({ isPending: false, isError: false, mutate: vi.fn() })
    .mockReturnValueOnce({ isPending: false, isError: false, mutate: vi.fn() });
  return renderToStaticMarkup(createElement(ReportsPage));
}

describe("ReportsPage", () => {
  beforeEach(() => {
    queryMocks.useQuery.mockReset();
    queryMocks.useMutation.mockReset();
    queryMocks.useQueryClient.mockClear();
  });

  it("builds global list filters for AI and available reports with pagination", () => {
    expect(createReportHistoryQuery("AI_REPORT", "AVAILABLE", 2)).toEqual({
      type: "AI_REPORT",
      status: "AVAILABLE",
      page: 2,
      pageSize: 20,
    });
    expect(createReportHistoryQuery("AI_PARAGRAPH_TECHNICAL", "AVAILABLE", 1)).toEqual({
      type: "AI_PARAGRAPH_TECHNICAL",
      status: "AVAILABLE",
      page: 1,
      pageSize: 20,
    });
  });

  it("shows the global report history and separates imported Turnitin reports", () => {
    const html = renderPage();

    expect(html).toContain("Reportes de Turniting");
    expect(html).toContain("Turnitin importados");
    expect(html).toContain("muestra_sintetica.docx");
    expect(html).toContain("31ec6f6f · V3_ONLY");
    expect(html).toContain("Disponible");
    expect(html).toContain("Menos de 2 h");
    expect(html).toContain("486 KB");
    expect(html).toContain("Descargar");
    expect(html).toContain("Ver PDF");
    expect(html).toContain("Eliminar");
    expect(html).toContain("Regenerar");
    expect(html).toContain("43.4 %");
    expect(html).toContain("SYNTHETIC");
    expect(html).toContain("Revisión original");
    expect(html).toContain("Detalle por párrafos");
    expect(html).toContain("IA anterior");
    expect(html).toContain("Expirados");
  });

  it("offers regeneration for expired reports and does not render a dead download link", () => {
    const html = renderPage("EXPIRED");

    expect(html).toContain("Expirado");
    expect(html).toContain("Regenerar");
    expect(html).not.toContain("Descargar</button>");
  });

  it("labels original and technical report history rows independently", () => {
    queryMocks.useQuery.mockReturnValue({
      data: {
        items: [
          artifact("AVAILABLE", "AI_ORIGINAL_REVIEW"),
          { ...artifact("AVAILABLE", "AI_PARAGRAPH_TECHNICAL"), id: "a2b2f3c5-14df-4156-a1df-152a7129f88e" },
        ],
        total: 2,
        page: 1,
        pageSize: 20,
      },
      isPending: false,
      isError: false,
    });
    queryMocks.useMutation
      .mockReturnValueOnce({ isPending: false, isError: false, mutate: vi.fn() })
      .mockReturnValueOnce({ isPending: false, isError: false, mutate: vi.fn() })
      .mockReturnValueOnce({ isPending: false, isError: false, mutate: vi.fn() });
    const html = renderToStaticMarkup(createElement(ReportsPage));

    expect(html).toContain("Revisión original");
    expect(html).toContain("Detalle por párrafos");
    expect(html.match(/Ver PDF/g)).toHaveLength(2);
    expect(html.match(/Descargar/g)).toHaveLength(2);
    expect(html.match(/43\.4 %/g)).toHaveLength(2);
    expect(html.match(/SYNTHETIC/g)).toHaveLength(2);
    expect(html).not.toContain(`href="/documents/${DOCUMENT_ID}"`);
  });
});
