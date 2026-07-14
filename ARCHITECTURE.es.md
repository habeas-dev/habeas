# Arquitectura de Habeas

Este documento explica los principios arquitectónicos detrás de Habeas.

Es intencionadamente agnóstico respecto a la tecnología. Describe *qué* es Habeas y *por qué* está diseñado de esta forma, en lugar de documentar detalles de implementación.

---

# Objetivos de diseño

Habeas existe para resolver un problema simple:

> Las personas usuarias deben poder recuperar **sus propios datos** de sitios web que ya los exponen en su interfaz web normal.

El proyecto se construye sobre unos pocos principios fundamentales.

## Local-first

Todo se ejecuta dentro del navegador de la persona usuaria.

No hay servidores de agregación.

No hay inicios de sesión remotos.

El proyecto nunca recibe credenciales ni datos personales de usuarios.

---

## Autenticación controlada por el usuario

La autenticación siempre sigue siendo responsabilidad de la persona usuaria.

Los usuarios:

- abren el sitio web;
- inician sesión de forma normal;
- completan MFA si es necesario.

Habeas simplemente opera dentro de esa sesión ya autenticada.

---

## Separación de responsabilidades

Habeas separa deliberadamente cuatro conceptos independientes:

- Fuentes
- Runtime
- Destinos
- Definiciones de fuente

Cada uno puede evolucionar de forma independiente.

---

# Arquitectura de alto nivel

```
              Grabador de sesión
                      │
                      ▼
            Definiciones de fuente
                      │
                      ▼
┌────────────────────────────────────────────┐
│                                            │
│              Runtime de Habeas             │
│                                            │
└────────────────────────────────────────────┘
         ▲                           ▲
         │                           │
         │                           │
      Fuentes                    Destinos
```

El runtime en sí no sabe nada sobre Carrefour, bancos o plataformas de inversión.

Eso lo proporcionan las definiciones de fuente.

Del mismo modo, el runtime no tiene opinión sobre dónde deben ir los datos recuperados.

Esa es responsabilidad de los Destinos.

---

# Fuentes

Una Fuente sabe cómo recuperar datos de un sitio web.

Ejemplos:

- supermercados
- bancos
- brokers
- empresas de suministros
- portales gubernamentales
- marketplaces online

Una Fuente entiende:

- navegación
- estado de autenticación
- descubrimiento de documentos
- extracción de datos

Una Fuente **no** decide qué ocurre con los datos recuperados.

---

# Salidas de las fuentes

Las Fuentes exponen los datos propios del proveedor.

Las salidas típicas incluyen:

- documentos PDF
- hojas de cálculo
- JSON estructurado
- imágenes
- formatos específicos del proveedor

Una decisión de diseño importante es que Habeas **no** intenta definir un formato universal de documentos.

En su lugar:

- los documentos permanecen nativos;
- los datos estructurados permanecen específicos de cada proveedor;
- los consumidores deciden cómo interpretarlos.

Habeas estandariza el **acceso**, no el **contenido**.

---

# Runtime

El Runtime es responsable de ejecutar las definiciones de fuente de forma segura dentro del navegador.

Sus responsabilidades incluyen:

- cargar Fuentes;
- coordinar la extracción;
- mostrar progreso a la persona usuaria;
- gestionar destinos;
- gestión de inventario;
- un almacén canónico de todo lo recuperado (navegable entre fuentes);
- detección de duplicados;
- sincronización automática;
- permisos;
- interfaz de usuario.

El Runtime no contiene deliberadamente lógica específica de proveedores.

---

# Destinos

Los Destinos consumen datos producidos por las Fuentes.

Ejemplos:

- Descargas
- Carpetas locales
- Google Drive
- Dropbox
- Servidores WebDAV
- Almacenamiento de objetos S3 (y compatibles con S3)
- Endpoints HTTP

Destinos futuros pueden incluir:

- aplicaciones de escritorio;
- software de finanzas personales;
- automatización del hogar;
- sistemas de backup;
- plataformas de gestión documental.

Un Destino no debería necesitar entender cómo funciona cada sitio web.

Su única preocupación es consumir datos expuestos a través del Runtime.

---

# Definiciones de fuente

Las definiciones de fuente describen cómo se comporta una Fuente.

Son intencionadamente independientes del Runtime.

Esto aporta varias ventajas:

- se pueden soportar nuevos sitios web sin modificar Habeas;
- las contribuciones de la comunidad siguen siendo pequeñas y revisables;
- el desarrollo de Fuentes puede evolucionar de forma independiente a las versiones del Runtime.

El Runtime ejecuta las definiciones de fuente.

No las contiene.

---

# Grabador de sesión

Uno de los objetivos de Habeas es hacer que la creación de Fuentes sea cada vez más accesible.

El Grabador de Sesión ayuda a las personas desarrolladoras observando una sesión de navegación real e infiriendo una definición de Fuente inicial.

Flujo típico:

1. La persona usuaria realiza el flujo normal.
2. Habeas registra la actividad del navegador.
3. Se infiere una definición de Fuente inicial.
4. La persona desarrolladora revisa el resultado generado.
5. Se refina la definición de Fuente.
6. Después puede contribuirse de vuelta a la comunidad.

El grabador ayuda al desarrollo.

No reemplaza la revisión humana.

---

# ¿Por qué no del lado servidor?

Muchos servicios existentes de agregación de datos operan:

- recopilando credenciales;
- almacenándolas;
- iniciando sesión en sitios web de forma remota;
- descargando datos en nombre de las personas usuarias.

Habeas evita deliberadamente esa arquitectura.

En su lugar:

- los usuarios se autentican por sí mismos;
- los sitios web ven el navegador normal de la persona usuaria;
- la MFA permanece sin cambios;
- las credenciales nunca salen del dispositivo.

Esto simplifica enormemente tanto la confianza como la privacidad.

---

# ¿Por qué no normalizar datos?

Muchas plataformas de agregación intentan crear un modelo de datos universal.

Habeas deliberadamente no lo hace.

Distintos proveedores exponen información fundamentalmente distinta.

Intentar normalizar todos los documentos posibles inevitablemente descartaría información o requeriría una capa de abstracción cada vez mayor.

En su lugar, Habeas estandariza la interfaz entre Fuentes y Destinos preservando las salidas nativas.

Las aplicaciones siguen siendo libres de interpretar esas salidas como elijan.

---

# Ecosistema impulsado por la comunidad

El Runtime es intencionadamente genérico.

Su utilidad crece a través del ecosistema que lo rodea:

- definiciones de Fuente
- Destinos
- herramientas para desarrolladores
- documentación
- contribuciones de la comunidad

Esta arquitectura permite que el proyecto escale horizontalmente sin aumentar continuamente la complejidad del Runtime.

---

# Flujo de datos típico

```
La persona usuaria abre el sitio web
          │
          ▼
La persona usuaria se autentica
          │
          ▼
La Fuente se ejecuta
          │
          ▼
Se producen documentos nativos / JSON
          │
          ▼
Runtime
          │
          ▼
Destino seleccionado
          │
          ▼
Carpeta / Drive / HTTP / Aplicación
```

Cada paso ocurre bajo control de la persona usuaria.

---

# Principios arquitectónicos

El proyecto puede resumirse en unas pocas reglas simples.

- Los usuarios se autentican por sí mismos.
- Habeas nunca almacena credenciales.
- Todo se ejecuta localmente.
- Las Fuentes recuperan datos.
- Los Destinos consumen datos.
- Las definiciones de fuente permanecen independientes.
- Los documentos nativos permanecen sin cambios.
- Habeas estandariza acceso, no contenido.
- Los usuarios deciden a dónde van sus datos.

Estos principios deberían guiar el desarrollo futuro.

Cualquier nueva funcionalidad debería evaluarse frente a ellos.

Si una funcionalidad viola uno de estos principios, probablemente no pertenezca a Habeas.
