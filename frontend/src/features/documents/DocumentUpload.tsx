import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getDocument, documentQueryKeys, uploadDocument } from '../../api/documents'
import type { DocumentRecord } from '../../api/documents'
import { Icon } from '../../components/Icon'
import { ApiErrorNotice } from './ApiErrorNotice'
import { TurnitingFeedback } from '../../components/TurnitingFeedback'
import { formatBytes } from './document-utils'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from './upload-limits'
import { operationErrorMessage } from '../analysis/analysis-utils'

const allowedExtensions = new Set(['pdf', 'docx', 'txt', 'png', 'jpg', 'jpeg'])

type ClientIssue = { code: string; message: string }

function getFileExtension(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

function processingDocument(status: DocumentRecord['status']) {
  return status === 'UPLOADED' || status === 'PROCESSING'
}

export function DocumentUpload() {
  const fileInput = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [clientIssue, setClientIssue] = useState<ClientIssue | null>(null)
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)

  const upload = useMutation({
    mutationFn: uploadDocument,
    onSuccess: (document) => {
      setSelectedFile(null)
      setClientIssue(null)
      setActiveDocumentId(document.id)
      queryClient.setQueryData(documentQueryKeys.detail(document.id), document)
      void queryClient.invalidateQueries({ queryKey: documentQueryKeys.all })
    },
  })

  const uploadStatus = useQuery({
    queryKey: activeDocumentId ? documentQueryKeys.detail(activeDocumentId) : ['documents', 'upload-status', 'idle'],
    queryFn: () => getDocument(activeDocumentId!),
    enabled: Boolean(activeDocumentId),
    retry: 1,
    refetchInterval: (query) => query.state.data && processingDocument(query.state.data.status) ? 2000 : false,
  })

  function chooseFile(file?: File) {
    upload.reset()
    setActiveDocumentId(null)
    setSelectedFile(null)
    setClientIssue(null)
    if (!file) return

    const extension = getFileExtension(file.name)
    if (!allowedExtensions.has(extension)) {
      setClientIssue({ code: 'CLIENT_UNSUPPORTED_FILE_TYPE', message: 'Elige un archivo PDF, DOCX, TXT, PNG o JPEG.' })
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setClientIssue({ code: 'CLIENT_FILE_TOO_LARGE', message: `El archivo supera el límite de ${MAX_UPLOAD_MB} MB.` })
      return
    }
    setSelectedFile(file)
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (event.dataTransfer.files.length > 1) {
      setSelectedFile(null)
      setClientIssue({ code: 'CLIENT_ONE_FILE_ONLY', message: 'Sube un solo archivo por vez.' })
      return
    }
    chooseFile(event.dataTransfer.files[0])
  }

  function startUpload() {
    if (selectedFile) upload.mutate(selectedFile)
  }

  const trackedDocument = uploadStatus.data ?? upload.data
  const isProcessing = Boolean(trackedDocument && processingDocument(trackedDocument.status))
  const isCompleted = trackedDocument?.status === 'EXTRACTED'
  const isOcrRequired = trackedDocument?.status === 'OCR_REQUIRED'
  const isProcessingFailed = trackedDocument?.status === 'FAILED'
  const uploadError = upload.isError ? upload.error : null
  const uploadStatusError = activeDocumentId && uploadStatus.isError ? uploadStatus.error : null

  return (
    <section className="upload-card" aria-labelledby="upload-title">
      <div className="upload-horizontal-bar">
        <div
          className={`upload-dropzone${selectedFile ? ' has-file' : ''}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <span className="upload-dropzone-icon"><Icon name="upload" size={18} /></span>
          <div className="upload-dropzone-copy">
            <strong id="upload-title">{selectedFile ? selectedFile.name : 'Subir un documento (arrastra o selecciona)'}</strong>
            <span>
              {selectedFile
                ? `${formatBytes(selectedFile.size)} · Listo para enviar al backend`
                : `PDF, DOCX, TXT, PNG o JPEG · hasta ${MAX_UPLOAD_MB} MB por archivo`}
            </span>
          </div>
          {selectedFile ? (
            <button
              className="button button-quiet"
              type="button"
              aria-label="Quitar el archivo seleccionado"
              onClick={() => chooseFile(undefined)}
              disabled={upload.isPending}
            >
              Cambiar
            </button>
          ) : (
            <button
              className="button button-quiet upload-browse-button"
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={upload.isPending}
            >
              Elegir archivo
            </button>
          )}
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            tabIndex={-1}
            accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/png,image/jpeg"
            aria-label="Seleccionar un archivo PDF, DOCX, TXT, PNG o JPEG"
            onChange={(event) => {
              chooseFile(event.currentTarget.files?.[0])
              event.currentTarget.value = ''
            }}
          />
        </div>

        <button
          className="button button-primary upload-submit-button"
          type="button"
          onClick={startUpload}
          disabled={!selectedFile || upload.isPending}
          aria-busy={upload.isPending}
        >
          <Icon name="upload" size={15} />
          <span>{upload.isPending ? 'Subiendo…' : 'Subir documento'}</span>
        </button>
      </div>

      {clientIssue && (
        <TurnitingFeedback state="file-error" title="Revisa el archivo" description={clientIssue.message} className="api-error" layout="inline">
          <code>{clientIssue.code}</code>
        </TurnitingFeedback>
      )}
      {uploadError && <ApiErrorNotice error={uploadError} title={operationErrorMessage('uploadError')} />}

      {selectedFile && !clientIssue && !trackedDocument && !upload.isPending && (
        <TurnitingFeedback state="ready" title="Archivo listo para analizar" description={selectedFile.name} className="upload-state" layout="inline" />
      )}

      {upload.isPending && (
        <TurnitingFeedback state="running" title="UPLOADING · Subiendo archivo" description="Estamos enviando el documento al backend." className="upload-state upload-state-processing" layout="inline" />
      )}

      {isProcessing && !uploadStatus.isError && (
        <TurnitingFeedback state="reading" title="PROCESSING · Procesando documento" description="El estado se actualizará automáticamente mientras se extrae el texto." className="upload-state upload-state-processing" layout="inline" />
      )}

      {isCompleted && trackedDocument && (
        <TurnitingFeedback state="success" title="READY · Documento completado" description="El texto está listo para consultarse." className="upload-state upload-state-complete" layout="inline">
          <Link className="button button-quiet upload-result-link" to={`/documents/${trackedDocument.id}`}>Ver documento</Link>
        </TurnitingFeedback>
      )}

      {isOcrRequired && trackedDocument && (
        <TurnitingFeedback state="warning" title="OCR_REQUIRED · OCR requerido" description="El documento está listo para procesar sus páginas escaneadas." className="upload-state upload-state-warning" layout="inline">
          <Link className="button button-quiet upload-result-link" to={`/documents/${trackedDocument.id}`}>Ver detalle</Link>
        </TurnitingFeedback>
      )}

      {isProcessingFailed && trackedDocument && (
        <TurnitingFeedback state="file-error" title="ERROR · Falló el procesamiento" description={trackedDocument.extractionError || 'Puedes revisar el detalle y volver a intentarlo.'} className="upload-state upload-state-error" layout="inline">
          <Link className="button button-quiet upload-result-link" to={`/documents/${trackedDocument.id}`}>Ver detalle</Link>
        </TurnitingFeedback>
      )}

      {uploadStatusError && (
        <ApiErrorNotice error={uploadStatusError} title="No se pudo actualizar el estado del documento" />
      )}

    </section>
  )
}
