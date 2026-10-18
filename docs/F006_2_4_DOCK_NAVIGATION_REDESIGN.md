# F006.2.4 — Navigation Redesign: Top Bar + Floating Bottom Dock (Sin Sidebar)

## 1. Motivación del cambio

En F006.2.3 se limpió la interfaz analítica y se eliminaron contenedores centrales estrechos, pero se conservó una barra lateral fija (`sidebar`) a la izquierda que restaba ancho útil al análisis de documentos y se alejaba de la arquitectura estructural de referencia (`turniting_macos_minimalist_redesign.html`).

El objetivo de **F006.2.4** es eliminar por completo la navegación lateral y adoptar una arquitectura de aplicación de escritorio moderna y sobria:

- **Top App Bar** fina y pegajosa (`sticky`) en la parte superior (`58px`).
- **Contenido Full-Width** ocupando el 100 % del ancho horizontal del viewport (`100dvh`, sin contenedor central estrecho ni doble scroll vertical).
- **Floating Bottom Dock** fijo en la parte inferior central para cambiar de vista mediante iconos con tooltips y estado activo discreto.

---

## 2. Qué se tomó del HTML de referencia (`turniting_macos_minimalist_redesign.html`)

Se tomó únicamente la **arquitectura estructural y espacial**:

1. **Top Bar contextual**:
   - Izquierda: marca `Turniting` + selector de espacio de trabajo (`Área académica ▾`).
   - Centro: ruta/contexto actual (`Espacio de trabajo / Inicio`, `Documentos / TESIS_EC_sin_Turnitin.docx`, etc.).
   - Derecha: indicador de estado (`● Entorno local`) + acción rápida `Subir`.
2. **Navegación inferior tipo Dock flotante**:
   - Barra flotante centrada abajo con iconos claros, tooltips al pasar el cursor o enfocar con teclado (`data-tooltip`), e indicador activo (`is-active` + punto inferior `#147a6d`).
   - Vistas integradas: `Inicio`, `Documentos`, `Análisis IA` (enlaza al documento activo o más reciente), `Comparar versiones`, `Reportes Turnitin`, `Modelos`, `Datasets` y acción rápida `+ Subir documento`.
3. **Distribución y mapa horizontal de párrafos en el analizador**:
   - Barra horizontal de distribución de niveles (`Alta`, `Moderada`, `Baja`, `Insuficiente`) integrada bajo la señal global.
   - Tira horizontal minimalista de navegación por párrafos (`Mapa de párrafos`) donde cada celda representa un párrafo con colores sobrios y permite saltar directamente a él.
4. **Compactación automática de secuencias `INSUFFICIENT_TEXT`**:
   - Secuencias consecutivas (`>= 2`) de bloques cortos/títulos con `INSUFFICIENT_TEXT` se agrupan automáticamente en una fila compacta (`Párrafos X–Y · N bloques cortos / títulos con texto insuficiente [Expandir (N)]`) cuando se visualiza en orden del documento.
5. **Tablas limpias estilo Finder / Notion**:
   - Tanto en `Inicio` (`Últimos documentos`) como en `Documentos` (`Tus documentos`) y con una barra de carga horizontal (`upload-horizontal-bar`).

---

## 3. Qué se descartó del HTML de referencia

Para mantener rigor académico, sobriedad visual e integridad de datos reales:

- **Descartados los botones decorativos tipo navegador/Safari** (*traffic lights* rojo/amarillo/verde y barra de direcciones simulada).
- **Descartados los gradientes ambientales y el exceso de glassmorphism** (`blur` reducido a un acabado ligero de `8px` sobre blanco `rgba(255, 255, 255, 0.94)`).
- **Descartados los colores saturados múltiples y anillos SVG circulares**: se mantiene una paleta sobria (`#f8fafc`, `#ffffff`, `#0f172a`, `#64748b`, `#e2e8f0`, acento `#147a6d`).
- **Descartado todo texto o función simulada (`mock data`)**: el frontend consume exclusivamente las APIs reales de documentos, análisis, contexto, comparación, reportes, modelos y datasets.
- **Descartado el panel inspector lateral permanente**: la inspección de contexto (`CONTEXTUAL_PARAGRAPH`) y los detalles técnicos se despliegan inline bajo el párrafo seleccionado sin robar ancho horizontal.

---

## 4. Estructura final de navegación y componentes modificados

- `frontend/src/App.tsx`:
  - Eliminado `<aside className="sidebar">` por completo.
  - Implementados `<header className="topbar">` y `<nav className="bottom-dock">`.
  - Rediseñada `DashboardPage` como espacio de trabajo con tabla de documentos recientes y estado compacto de servicios.
- `frontend/src/features/documents/DocumentUpload.tsx` y `DocumentListPage.tsx`:
  - Barra horizontal de subida y tabla completa estilo Finder/Notion.
- `frontend/src/features/analysis/AnalysisPanel.tsx`:
  - Barra de distribución por niveles (`analysis-distribution`).
  - Mapa horizontal de párrafos (`analysis-heatmap-strip`) con salto directo a cada párrafo.
  - Agrupación automática colapsable de secuencias consecutivas `INSUFFICIENT_TEXT` (`groupParagraphSegments`).
- `frontend/src/App.css`:
  - Reglas de layout `100dvh` full-width, topbar sticky, dock flotante desktop/tablet y barra inferior móvil sin regresión a sidebar.
