import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ useState: vi.fn(), useMemo: vi.fn(), useEffect: vi.fn() }));
const api = vi.hoisted(() => ({
  generateAIReport: vi.fn(), generateBothAIReports: vi.fn(),
  regenerateReport: vi.fn(), downloadReport: vi.fn(), deleteReport: vi.fn(),
  uploadDocument: vi.fn(), analyzeDocument: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  useQuery: vi.fn(), useMutation: vi.fn(),
  invalidateQueries: vi.fn(), setQueryData: vi.fn(),
}));

vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), ...hooks }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: queries.useQuery, useMutation: queries.useMutation,
  useQueryClient: () => queries,
}));
vi.mock("../../api/reports", async (original) => ({ ...await original<typeof import("../../api/reports")>(), ...api }));
vi.mock("../../api/documents", () => ({ uploadDocument: api.uploadDocument }));
vi.mock("../../api/analysis", async (original) => ({ ...await original<typeof import("../../api/analysis")>(), analyzeDocument: api.analyzeDocument }));

import { ReportExportPanel } from "./ReportExportPanel";
import { ReportsPage } from "../reports/ReportsPage";

const DOCUMENT_ID = "66b2f3c5-14df-4156-a1df-152a7129f88e";
const VERSION_ID = "8edee971-57eb-478b-b811-5f83b8115ea3";
const RUN_ID = "31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4";
const NEW_RUN_ID = "c2b2f3c5-14df-4156-a1df-152a7129f88e";
const ORIGINAL_ID = "e564fa70-4188-4e8e-a4eb-98fda94f8865";
const TECHNICAL_ID = "a2b2f3c5-14df-4156-a1df-152a7129f88e";

type Props = { children?: ReactNode; onClick?: () => void; disabled?: boolean };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function click(tree: ReactNode, label: string, index = 0) {
  const button = elements(tree).filter((node) => node.type === "button" && text(node.props.children) === label)[index];
  expect(button, label).toBeDefined();
  expect(button.props.disabled).not.toBe(true);
  button.props.onClick?.();
}

const run = { id: RUN_ID, status: "COMPLETED", documentId: DOCUMENT_ID, analyzerMode: "ENSEMBLE", documentScore: 0.434, threshold: 0.59 };
function report(type: "AI_ORIGINAL_REVIEW" | "AI_PARAGRAPH_TECHNICAL") {
  return {
    id: type === "AI_ORIGINAL_REVIEW" ? ORIGINAL_ID : TECHNICAL_ID,
    documentId: DOCUMENT_ID, documentVersionId: VERSION_ID, analysisRunId: RUN_ID,
    type, status: "AVAILABLE", filename: `turniting_${type === "AI_ORIGINAL_REVIEW" ? "original-review" : "paragraph-technical"}_66b2f3c5_2026-10-20.pdf`,
    expiresAt: "2026-10-21T12:00:00.000Z", sizeBytes: 1000,
  };
}

describe("report UI source isolation", () => {
  let states: unknown[];
  let setters: ReturnType<typeof vi.fn>[];
  let stateIndex: number;
  let effects: Array<() => void>;
  let runs: Array<typeof run>;
  let artifacts: ReturnType<typeof report>[];
  let queryIndex: number;

  function render() {
    stateIndex = 0;
    queryIndex = 0;
    effects = [];
    return ReportExportPanel({ documentId: DOCUMENT_ID, canExport: true });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    states = [];
    setters = [];
    runs = [run];
    artifacts = [];
    hooks.useState.mockImplementation((initial?: unknown) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      setters[index] ??= vi.fn((value: unknown) => {
        states[index] = typeof value === "function" ? value(states[index]) : value;
      });
      return [states[index], setters[index]];
    });
    hooks.useMemo.mockImplementation((compute: () => unknown) => compute());
    hooks.useEffect.mockImplementation((effect: () => void) => effects.push(effect));
    queries.useQuery.mockImplementation(() => ({
      data: { items: queryIndex++ === 0 ? runs : artifacts }, isPending: false, isError: false,
    }));
    queries.useMutation.mockImplementation((options: { mutationFn: (value: unknown) => unknown }) => ({
      mutate: (value: unknown) => options.mutationFn(value), isPending: false, isError: false,
    }));
  });

  it("generates each variant and both with the same explicit run, without ingestion or inference", () => {
    const tree = render();
    click(tree, "Generar revisión original");
    click(tree, "Generar detalle por párrafos");
    click(tree, "Generar ambos reportes");

    expect(api.generateAIReport.mock.calls).toEqual([
      [DOCUMENT_ID, RUN_ID, "AI_ORIGINAL_REVIEW"],
      [DOCUMENT_ID, RUN_ID, "AI_PARAGRAPH_TECHNICAL"],
    ]);
    expect(api.generateBothAIReports).toHaveBeenCalledWith(DOCUMENT_ID, RUN_ID);
    expect(api.uploadDocument).not.toHaveBeenCalled();
    expect(api.analyzeDocument).not.toHaveBeenCalled();
    expect(queries.setQueryData).not.toHaveBeenCalled();
  });

  it("locks the selected run after load even when a newer completed run arrives", () => {
    render();
    effects.forEach((effect) => effect());
    runs = [{ ...run, id: NEW_RUN_ID }, run];
    const tree = render();
    click(tree, "Generar ambos reportes");

    expect(api.generateBothAIReports).toHaveBeenCalledWith(DOCUMENT_ID, RUN_ID);
    expect(states[0]).toBe(RUN_ID);
  });

  it("does not silently use another run when the selected run disappears", () => {
    render();
    effects.forEach((effect) => effect());
    runs = [{ ...run, id: NEW_RUN_ID }];
    const tree = render();
    const both = elements(tree).find((node) => node.type === "button" && text(node.props.children) === "Generar ambos reportes");
    expect(both?.props.disabled).toBe(true);
    expect(states[0]).toBe(RUN_ID);
    expect(api.generateBothAIReports).not.toHaveBeenCalled();
  });

  it("previews both cards and history using only preview state; download and regeneration retain the source run", () => {
    artifacts = [report("AI_ORIGINAL_REVIEW"), report("AI_PARAGRAPH_TECHNICAL")];
    const tree = render();
    click(tree, "Ver revisión original");
    expect(states[1]).toBe(ORIGINAL_ID);
    click(tree, "Ver detalle por párrafos");
    expect(states[1]).toBe(TECHNICAL_ID);
    click(tree, "Ver revisión original", 1);
    expect(states[1]).toBe(ORIGINAL_ID);
    click(tree, "Ver detalle por párrafos", 1);
    expect(states[1]).toBe(TECHNICAL_ID);
    setters[0].mockClear();
    const stateBeforeDownload = [...states];
    click(tree, "Descargar revisión original");
    click(tree, "Descargar detalle por párrafos");
    click(tree, "Regenerar revisión original");
    click(tree, "Regenerar detalle por párrafos");

    expect(api.downloadReport.mock.calls).toEqual([[artifacts[0]], [artifacts[1]]]);
    expect(api.regenerateReport.mock.calls).toEqual([[ORIGINAL_ID], [TECHNICAL_ID]]);
    expect(states).toEqual(stateBeforeDownload);
    expect(setters[0]).not.toHaveBeenCalled();
    expect(queries.setQueryData).not.toHaveBeenCalled();
    expect(api.uploadDocument).not.toHaveBeenCalled();
    expect(api.analyzeDocument).not.toHaveBeenCalled();
  });

  it("global history opens report preview without selecting a document or uploading its PDF", () => {
    const artifact = { ...report("AI_ORIGINAL_REVIEW"), documentName: "thesis-fixture.pdf" };
    queries.useQuery.mockReturnValue({ data: { items: [artifact], total: 1, page: 1, pageSize: 20 }, isPending: false, isError: false });
    stateIndex = 0;
    const tree = ReportsPage();
    click(tree, "thesis-fixture.pdf");
    expect(states[3]).toBe(ORIGINAL_ID);
    click(tree, "Ver PDF");
    expect(states[3]).toBe(ORIGINAL_ID);
    click(tree, "Descargar");
    expect(api.downloadReport).toHaveBeenCalledWith(artifact);
    expect(states[0]).toBeUndefined();
    expect(states[1]).toBeUndefined();
    expect(states[2]).toBe(1);
    expect(queries.setQueryData).not.toHaveBeenCalled();
    expect(api.uploadDocument).not.toHaveBeenCalled();
    expect(api.analyzeDocument).not.toHaveBeenCalled();
  });
});
