const configuredMaxUploadMb = Number(import.meta.env.VITE_MAX_UPLOAD_MB)

export const MAX_UPLOAD_MB = Number.isFinite(configuredMaxUploadMb) && configuredMaxUploadMb > 0
  ? configuredMaxUploadMb
  : 20

export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

const configuredMaxTurnitinReportMb = Number(import.meta.env.VITE_MAX_TURNITIN_REPORT_MB)

export const MAX_TURNITIN_REPORT_MB = Number.isFinite(configuredMaxTurnitinReportMb) && configuredMaxTurnitinReportMb > 0
  ? configuredMaxTurnitinReportMb
  : 30
