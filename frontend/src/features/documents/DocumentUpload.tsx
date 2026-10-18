import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getDocument, documentQueryKeys, uploadDocument } from '../../api/documents'
import type { DocumentRecord } from '../../api/documents'
import { Icon } from '../../components/Icon'
import { ApiErrorNotice } from './ApiErrorNotice'
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
        <div className="api-error" role="alert">
          <div><strong>Revisa el archivo</strong><p>{clientIssue.message}</p><code>{clientIssue.code}</code></div>
        </div>
      )}
      {uploadError && <ApiErrorNotice error={uploadError} title={operationErrorMessage('uploadError')} />}

      {upload.isPending && (
        <div className="upload-state upload-state-processing" role="status" aria-live="polite">
          <span className="state-indicator is-animated" />
          <span><strong>UPLOADING · Subiendo archivo</strong><small>Estamos enviando el documento al backend.</small></span>
        </div>
      )}

      {isProcessing && !uploadStatus.isError && (
        <div className="upload-state upload-state-processing" role="status" aria-live="polite">
          <span className="state-indicator is-animated" />
          <span><strong>PROCESSING · Procesando documento</strong><small>El estado se actualizará automáticamente.</small></span>
        </div>
      )}

      {isCompleted && trackedDocument && (
        <div className="upload-state upload-state-complete" role="status" aria-live="polite">
          <span className="state-indicator"><Icon name="check" size={13} /></span>
          <span><strong>READY · Documento completado</strong><small>El texto está listo para consultarse.</small></span>
          <Link className="button button-quiet upload-result-link" to={`/documents/${trackedDocument.id}`}>Ver documento</Link>
        </div>
      )}

      {isOcrRequired && trackedDocument && (
        <div className="upload-state upload-state-warning" role="status" aria-live="polite">
          <span className="state-indicator">!</span>
          <span><strong>OCR_REQUIRED · OCR requerido</strong><small>El documento está listo para procesar sus páginas escaneadas.</small></span>
          <Link className="button button-quiet upload-result-link" to={`/documents/${trackedDocument.id}`}>Ver detalle</Link>
        </div>
      )}

      {isProcessingFailed && trackedDocument && (
        <div className="upload-state upload-state-error" role="alert">
          <span className="state-indicator">!</span>
          <span><strong>ERROR · Falló el procesamiento</strong><small>{trackedDocument.extractionError || 'Puedes revisar el detalle y volver a intentarlo.'}</small></span>
          <Link className="button button-quiet upload-result-link" to={`/documents/${trackedDocument.id}`}>Ver detalle</Link>
        </div>
      )}

      {uploadStatusError && (
        <ApiErrorNotice error={uploadStatusError} title="No se pudo actualizar el estado del documento" />
      )}

    </section>
  )
}
