# Habeas — Especificación funcional

> **Nombre:** **Habeas** (de *habeas data*, el derecho a tus propios datos) — ver §12.
> **Identidad:** dominio `habeas.dev` · GitHub `habeas-dev` · npm `habeas` (todos disponibles a fecha de este borrador).
> **Estado:** borrador v0.1 · **Licencia prevista:** AGPL-3.0 · **Ámbito:** proyecto open-source independiente

---

## 1. Visión y problema

Millones de datos personales —tickets de compra, facturas de luz/gas/telco, movimientos de tarjeta de crédito, carteras de inversión, pensiones— están encerrados tras webs autenticadas que **bloquean el acceso automatizado** (Cloudflare, Akamai, DataDome…) y **no ofrecen ni API ni export por email**. El usuario *tiene derecho* a esos datos (GDPR Art. 20, portabilidad), pero en la práctica no puede sacarlos de forma útil.

Los agregadores comerciales (Plaid, Tink, TrueLayer) resuelven parte de esto haciendo **scraping server-side con credenciales custodiadas**, lo que les obliga a pelear el anti-bot, custodiar contraseñas y asumir una responsabilidad enorme — y aun así solo cubren cuentas de pago PSD2, dejando fuera tarjetas de crédito, inversión y pensiones.

**Tesis del proyecto:** una extensión de navegador que extrae los datos **dentro de la sesión real del propio usuario** hace lo mismo *mejor y más barato*:

- **Sin pelea anti-bot** — es el navegador y la IP del usuario, ya validados.
- **Sin custodia de credenciales** — el usuario se loguea él mismo.
- **La MFA/OTP la resuelve el usuario en vivo**, no un servidor.
- **Local-first** — los datos van a donde el usuario decida (fichero, o la app que elija).

## 2. Objetivos y no-objetivos

### Objetivos
- **G1.** Extraer datos personales autenticados de servicios sin API/email, ejecutándose en la sesión del usuario.
- **G2.** Modelo de **adaptadores por servicio**, mayoritariamente **declarativos** (datos, no código) para poder auditarlos y crowdsourcearlos.
- **G3.** **Salida normalizada** por dominio (recibo, factura, movimiento…) para que cualquier consumidor la ingiera igual.
- **G4.** **Sinks configurables por el usuario**: fichero local, o POST a un endpoint que el usuario elija (p. ej. Tiquetera, Cuéntamo).
- **G5.** **Local-first y consentimiento explícito**: nada sale del navegador sin que el usuario apruebe qué se lee y a dónde va.

### No-objetivos
- **N1.** No es un scraper genérico *point-and-click* de webs públicas (ya existen: get-set-fetch, webscraper.io).
- **N2.** No custodia credenciales ni automatiza el login saltándose la MFA.
- **N3.** No es un servicio centralizado que scrapea *en nombre* del usuario; el usuario ejecuta la herramienta.
- **N4.** No inicia pagos ni operaciones (no es un actor PSD2 regulado).
- **N5.** No pretende derrotar anti-bots por sí mismo: se apoya en la sesión ya validada del usuario.

## 3. Personas y casos de uso

- **Ana (usuaria final):** quiere que sus tickets de Carrefour aparezcan en Tiquetera sin reenviar PDFs a mano.
- **Bruno (usuario de Cuéntamo):** quiere sus movimientos de tarjeta de crédito e inversión, que PSD2 no le da.
- **Clara (contribuidora técnica):** escribe un adaptador declarativo para su comercializadora de luz y lo aporta al repo.
- **David (consumidor / desarrollador de app):** integra el extractor publicando un endpoint de ingest + su esquema.

Flujo canónico (Ana):
1. Instala la extensión y empareja Tiquetera (pega un token generado en los ajustes de Tiquetera).
2. Activa el adaptador *Carrefour*; la extensión le muestra: "leerá `carrefour.es`, enviará a `tiquetera.es`". Acepta.
3. Entra en su cuenta de Carrefour (login + OTP los hace ella).
4. En "Mis compras" pulsa **Sincronizar** (o se dispara al entrar en la página).
5. La extensión llama al endpoint interno del sitio con las cookies de la sesión, descarga los PDF/registros nuevos, los normaliza y los envía a Tiquetera.

## 4. Glosario

| Término | Definición |
|---|---|
| **Core** | El runtime de la extensión: único código revisado. Interpreta adaptadores, orquesta captura, normaliza y exporta. |
| **Adaptador** | Definición **declarativa** por servicio (p. ej. `carrefour`): cómo detectar sesión, enumerar registros, obtener detalle, mapear campos. |
| **Capture SDK** | Primitivas que el Core ofrece a los adaptadores: fetch con credenciales, selección DOM, paginación, descarga de blob/PDF. |
| **Record** | Un dato extraído ya normalizado (un ticket, una factura, un movimiento). |
| **Schema** | Esquema normalizado por dominio al que un adaptador mapea sus registros. |
| **Sink** | Destino de los registros: fichero local, descarga, o POST a un endpoint del usuario. |
| **Consumer** | App externa que recibe registros vía un sink (Tiquetera, Cuéntamo). |
| **Capability scope** | Permisos declarados de un adaptador: qué hosts lee y a qué sink puede escribir. |

## 5. Arquitectura

```
┌─ CORE (extensión, único código revisado) ────────────────────┐
│  trigger · detección de sesión · Capture SDK ·               │
│  normalización → schemas · sinks (fichero / POST) ·          │
│  gestor de consentimiento y capability scope                 │
└───────────────▲───────────────────────────────┬──────────────┘
   interpreta    │                                │ exporta
                 │                                ▼
┌─ ADAPTADORES (datos, no código) ─┐   ┌─ CONSUMERS ────────────┐
│  carrefour.yaml · endesa.yaml ·  │   │  Tiquetera (tickets)   │
│  movistar.yaml · …               │   │  Cuéntamo  (finanzas)  │
│  host match · señal de login ·   │   │  publican su endpoint  │
│  endpoint lista · fetch detalle ·│   │  de ingest + schema    │
│  mapeo de campos · paginación ·  │   └────────────────────────┘
│  capability scope                │
└──────────────────────────────────┘
```

**Principio de acoplamiento:** el Core no conoce a Tiquetera ni a Cuéntamo; solo sabe de *schemas* y *sinks*. Los consumidores no conocen los adaptadores; solo reciben registros normalizados.

## 6. Requisitos funcionales

### 6.1 Core runtime
- **FR-1** Cargar y validar adaptadores contra un JSON Schema del formato de adaptador.
- **FR-2** Detectar si el usuario tiene sesión activa en el host de un adaptador (señal declarada por el adaptador).
- **FR-3** Ejecutar el ciclo *enumerar → obtener detalle → normalizar → depurar duplicados → exportar*.
- **FR-4** Deduplicar por clave estable declarada por el adaptador (p. ej. nº de ticket) para no re-enviar lo ya extraído.
- **FR-5** Registrar un histórico local de sincronizaciones (qué, cuándo, cuántos registros, errores).

### 6.2 Modelo de adaptador (declarativo)
- **FR-6** Formato declarativo (YAML/JSON) con: `id`, `hosts`, `loginSignal`, `list` (endpoint/selector + paginación), `detail` (fetch por registro), `fields` (mapeo vía JSONPath/CSS), `dedupeKey`, `schema` destino, `capabilities`.
- **FR-7** Los adaptadores **no ejecutan JS arbitrario**. Para lógica no expresable de forma declarativa, un conjunto **acotado** de transformaciones predefinidas (fechas, importes, regex de extracción) — nunca `eval`.
- **FR-8** Versionado de adaptadores y comprobación de compatibilidad con la versión del Core.

### 6.3 Capture SDK
- **FR-9** `fetch` **con credenciales de la sesión** (`credentials:'include'`), same-origin al host del adaptador — las cookies y el `cf_clearance` viajan solos.
- **FR-10** Descarga de **blobs/PDF** autenticados y su envío al sink.
- **FR-11** Lectura de DOM (para servicios sin endpoint JSON: fallback a scraping de la página renderizada).
- **FR-12** Paginación (cursor, offset o "cargar más") declarada por el adaptador.

### 6.4 Normalización y esquemas
- **FR-13** Esquemas normalizados versionados por dominio. MVP: **`receipt`** (ticket) y **`transaction`** (movimiento financiero). Después: `invoice`, `energy_reading`, `investment_position`.
- **FR-14** Cada registro exportado incluye metadatos de procedencia: adaptador, host, timestamp de captura, versión de esquema.

### 6.5 Sinks / exportación
- **FR-15** Sink **fichero**: JSON + ZIP de PDFs (descarga local).
- **FR-16** Sink **HTTP**: POST autenticado con **token de emparejamiento por usuario** a un endpoint elegido por el usuario.
- **FR-17** Un adaptador solo puede escribir al sink permitido por su `capabilities` y aprobado por el usuario.

### 6.6 Trigger y sesión
- **FR-18** Disparo **iniciado por el usuario** (botón "Sincronizar") como modo por defecto.
- **FR-19** Disparo **al entrar en la página** del servicio (opcional, con aviso).
- **FR-20** *No* hay disparo en segundo plano con sesión guardada sin el usuario presente en el MVP (reintroduce anti-bot/OTP y desdibuja la postura legal). Se evaluará más adelante.

### 6.7 Consentimiento y permisos (UX)
- **FR-21** Antes de activar un adaptador, mostrar en lenguaje claro: **qué hosts leerá** y **a qué sink enviará**. Requiere aprobación explícita.
- **FR-22** Panel de "mis conexiones": adaptadores activos, último sync, revocar en un clic.
- **FR-23** Vista previa de lo que se va a enviar antes del primer envío ("se enviarán 42 tickets a tiquetera.es").

### 6.8 Inventario de documentos

- **FR-24** El principio es **inventariar antes de exportar**: por cada adaptador
  activo, el Core enumera **todos los documentos disponibles** (no solo los de un
  tipo) y construye un **inventario** que se muestra al usuario: fecha, tipo,
  origen, importe/entidad, y estado (nuevo / ya sincronizado).
- **FR-25** La extracción/descarga y el envío a un sink son **acciones posteriores
  del usuario** sobre ese inventario (por documento o en lote), nunca automáticas.
  Refuerza local-first (SEC-1) y la vista previa antes de enviar (FR-23).
- **FR-26** El inventario es la unidad de deduplicación y de "qué falta por traer":
  el Core marca lo ya extraído por `dedupeKey` (FR-4).

## 7. Seguridad y privacidad

- **SEC-1 Local-first.** Por defecto los datos no salen del navegador; enviar a un sink remoto es una acción explícita del usuario.
- **SEC-2 Sin credenciales.** Nunca se almacenan usuario/contraseña del servicio; se depende de la sesión viva.
- **SEC-3 Capability scope.** Cada adaptador declara y queda confinado a sus hosts de lectura y su sink de escritura; el Core lo hace cumplir.
- **SEC-4 Adaptadores como datos.** Al no ejecutar JS remoto (además obligado por MV3), un adaptador malicioso no puede exfiltrar libremente; su superficie es el formato declarativo revisado.
- **SEC-5 Niveles de confianza de adaptador.**
  - *Comunidad* (tickets, facturas, servicios de bajo riesgo): revisados y firmados en el repo.
  - *First-party* (**banca, tarjetas, inversión**): **solo** mantenidos y firmados por el proyecto, con listón de revisión mayor. **No** se aceptan adaptadores financieros de la comunidad sin auditoría.
- **SEC-6 Datos sensibles.** Para dominios financieros/salud, reforzar local-first y minimización; el envío a un consumidor es opt-in por-adaptador y por-envío.
- **SEC-7 Transparencia.** Log local auditable de cada lectura y envío.

## 8. Postura legal

- **Base:** GDPR Art. 20 (portabilidad) — el usuario ejerce su derecho sobre *sus* datos, en *su* sesión, con una herramienta open-source que él ejecuta. La herramienta **no** scrapea en nombre de terceros ni centraliza datos.
- **Zona gris:** los ToS de cada servicio suelen prohibir el acceso automatizado. La postura "datos propios + sesión propia + software libre ejecutado por el usuario" es la más defendible, pero no inmuniza. Se documentará por-adaptador el nivel de riesgo.
- **Financiero:** al no iniciar pagos, el proyecto no es un actor PSD2 regulado; pero el deber de protección de datos es máximo → local-first reforzado.
- **Descargo:** el proyecto provee la herramienta; el uso responsable (y el cumplimiento de los ToS aplicables) es del usuario.

## 9. Consumidores de referencia

### Tiquetera (tickets)
- Publica `POST /api/ingest/receipts` con token de usuario; acepta esquema `receipt` + PDFs adjuntos.
- Reutiliza `TicketImportService` para parsear los PDFs.
- Aporta *upstream* el adaptador `carrefour` (y potencialmente `dia`, como PDF).

### Cuéntamo (finanzas)
- Publica ingest para esquema `transaction` / `investment_position`.
- **Estrategia de banca:** PSD2 AIS (agregador licenciado) como vía primaria para cuentas corrientes SEPA; el extractor como fuente de **primer nivel** para lo que PSD2 no cubre (tarjetas de crédito, inversión, pensiones, cripto, historial largo).
- Adaptadores financieros = *first-party* (SEC-5).

## 10. Alcance del MVP y fases

**MVP (validar la tesis client-side-en-sesión):**
- Core mínimo + Capture SDK (fetch con credenciales + descarga PDF).
- **1 adaptador real: Carrefour** (esquema `receipt`).
- Sinks: fichero local + HTTP a Tiquetera.
- UX de consentimiento básica.
- *Antes del MVP:* prototipo "sucio" como **userscript** para confirmar que el fetch autenticado pasa en la sesión real y ver qué devuelve el endpoint interno de Carrefour.

**Fase 2 (probar la abstracción):**
- **2º adaptador** de otro dominio (p. ej. comercializadora de luz → esquema `invoice`) — obliga a que el formato de adaptador sea de verdad genérico.
- Formalizar el formato declarativo + JSON Schema del adaptador.
- Empaquetar como extensión MV3 (Firefox-first; evaluar Chrome Web Store).

**Fase 3 (finanzas / Cuéntamo):**
- Esquema `transaction`, primer adaptador financiero first-party, refuerzos SEC-5/6.
- Panel de conexiones, dedupe robusto, histórico.

## 11. Riesgos y preguntas abiertas

- **R1.** ¿El endpoint interno de cada servicio es un JSON estable, o hay que scrapear DOM? (Se decide por-adaptador; el SDK soporta ambos.)
- **R2.** **Treadmill de mantenimiento:** cada web que cambia rompe su adaptador. Sin comunidad no escala; arrancar comunidad es lo difícil. El formato declarativo baja la barrera de contribución.
- **R3.** **Store review:** una extensión de scraping (más si toca banca) puede ser rechazada/retirada por Chrome. → Firefox-first / distribución propia.
- **R4.** **MV3 sin código remoto:** confirma la decisión de adaptadores declarativos; los financieros first-party van en el bundle.
- **R5.** ¿Modelo de sesión en segundo plano en el futuro? Reintroduce anti-bot/OTP y riesgo legal — fuera del MVP.
- **R6.** Solo desktop; usuarios solo-móvil quedan fuera (mitigado: la cuenta web existe para todos).

## 12. Nombre

**Dirección elegida: resonancia internacional** (no limitarse a la familia de marcas en español).

**Nombre elegido: `Habeas`** — de *habeas data*, el derecho constitucional (LatAm: Brasil, Colombia, Argentina; concepto legal global) a **acceder, rectificar y borrar los datos personales propios en poder de terceros**. La herramienta ejecuta ese derecho. Ventajas: significado exacto, raíz latina que viaja internacionalmente y a la vez resuena en el mundo hispanohablante, sin colisión OSS dominante (la vieja *Habeas Inc.* de anti-spam está muerta hace ~20 años). Tagline: *"tus datos, en tus manos"*.

**Alternativas evaluadas:**
- `Furet` (hurón en francés) — conserva la mascota de hurón, legible internacionalmente, parece libre; sin la carga de significado legal.
- `Repat` (repatriate) — "trae tus datos a casa"; coined, distintivo.

**Descartados por colisión:** `Ferret`/`Data Ferret` (FerretDB, ferret.ai, y una librería de scraping declarativo homónima — saturado en el propio dominio), `Polecat` (risk-intelligence establecido), `Datamule` (múltiples proyectos), `Recolecta`/`Cosecha` (saturado en agro).

**Disponibilidad verificada:** dominio `habeas.dev` y `habeas.app` libres (`.com/.org/.io/.net/.xyz` ocupados); GitHub `habeas-dev` libre (`habeas` a secas ocupado); npm `habeas` y scope `@habeas/*` libres. **Acción del usuario:** registrar dominio + reservar org GitHub + publicar placeholder npm para asegurar el trío.

## 13. Anexo — ejemplo de adaptador (ilustrativo, Carrefour)

```yaml
id: carrefour-es
version: 0.1.0
name: Carrefour España — tickets
hosts:
  read: ["www.carrefour.es"]
loginSignal:
  type: cookie          # o selector DOM / endpoint 200
  cookie: "sessionToken"
list:
  request:
    method: GET
    url: "https://www.carrefour.es/{{endpoint_interno_por_descubrir}}"
    credentials: include
  itemsPath: "$.tickets[*]"     # JSONPath sobre la respuesta
  pagination:
    type: cursor
    cursorPath: "$.nextCursor"
detail:
  pdf:
    urlTemplate: "https://www.carrefour.es/{{ticketPdfPath}}"
    credentials: include
fields:
  externalId: "$.id"
  date:       { path: "$.date", transform: "date:DD/MM/YYYY" }
  total:      { path: "$.amount", transform: "money:EUR" }
  store:      "$.storeName"
dedupeKey: externalId
schema: receipt@1
capabilities:
  read:  ["www.carrefour.es"]
  write: ["tiquetera.es"]
```
