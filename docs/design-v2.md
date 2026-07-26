# VFS Sync v2 — `.vfs` mínimo y sync por metadatos

Sucede a [`design.md`](./design.md), que describe lo implementado hoy. Reemplaza sus secciones 3
(modelo de commits), 5 (borrados), 6 (renames), 7 (conflictos) y 8 (algoritmo de sync); las
secciones 1 (VFSAdapter), 2 (`.vfs` como carpeta de control) y 4 (filtro mtime+size) siguen
vigentes tal cual.

No hay migración: nada de esto está en producción, así que v2 sustituye el formato sin negociarlo.

## Por qué

Dos observaciones, una del código y una del producto.

**Del código.** El grafo de commits completo — `commits/`, `known-commits.log`, los objetos tree, la
negociación de ancestro común — existe para producir **un campo por fichero**. Es literalmente esto,
en `merge.ts`:

```ts
const contentChangedA = !ancestor || ancestor.hash !== left.hash || …
const contentChangedB = !ancestor || ancestor.hash !== right.hash || …
```

El ancestro se usa para responder "¿cambió este lado?" y para la dimensión de ubicación
(`ancestor.path`). Nada más. Si cada entrada lleva su versión anterior, el merge funciona igual sin
grafo.

**Del producto.** El sincronizador no necesita razonar sobre el contenido de los ficheros: si una
versión es más nueva que otra, gana la más nueva. El hash sigue siendo necesario —para saber si dos
lados difieren de verdad, y para verificar lo que se recibe— pero **no como dirección de
almacenamiento**. Y en Drive ya casi no almacenamos blobs: con `reconstructBlobs` el fichero de
trabajo *es* el blob, así que `objects/` guarda sobre todo trees.

De ahí sale v2: el árbol de trabajo es el contenido, `.vfs` es sólo metadatos, y el metadato es tan
compacto que puede leerse entero de una vez.

### Qué desaparece

| v1 | v2 |
| --- | --- |
| `config.json` | cabecera de `vfs.json` |
| `objects/<xx>/<hash>` | **desaparece** — el fichero de trabajo es el contenido |
| `commits/<hash>.json` | filas de `commits` |
| `known-commits.log` | **desaparece** — no hay DAG que negociar |
| `hash-cache.json` | entradas de `vfs.json` (ya son `path → {hash, mtime, size}`) |

Con ello se van también el modo `reconstruct` (pasa a ser el único comportamiento),
`materialize`/`hasStoredObject`/`objectPath`, el reparto en buckets de dos caracteres, y la
recolección de basura sobre `objects/` que quedó pendiente en v1.

### Coste en Drive

Los números de v1 están medidos en `test/gdrive-traffic.test.ts` y en el modelo del explorador
(carpeta con 1 subcarpeta y 3 ficheros); los de v2 son el coste estructural del protocolo.

| acción | v1 (medido) | v2 |
| --- | --- | --- |
| abrir una carpeta vFS | 11 llamadas | **1** (leer `vfs.json`) |
| desplegar `.vfs` | 1 por carpeta, ~1 por bucket | **1** (dos entradas) |
| sync sin cambios | ~10 | **1 por peer** (leer su `vfs.json`) |
| sync moviendo N ficheros | ~36 con N=3 | 1 + N lecturas + N escrituras + 2 |

## 0. Carga de trabajo prevista

El sistema es para **catálogos multimedia**: ROMs de videojuegos y ficheros de música, cada uno con
sus ficheros de metadatos al lado. Eso tiene una forma muy concreta, y varias decisiones de este
documento salen de ella:

| rasgo del catálogo | consecuencia de diseño |
| --- | --- |
| El contenido pesado es **inmutable**: una ROM o un `.flac` se escribe una vez y no se vuelve a editar | El log crece con creaciones y renombrados, no con reescrituras del mismo fichero. Podar filas superadas apenas ahorraría: lo que acota el fichero activo es rotar (§3) |
| Lo que se edita son los **metadatos**: `.nfo`, `gamelist.xml`, `.cue`, `.m3u`, etiquetas | Los conflictos reales son de ficheros pequeños. Guardar una copia del perdedor es baratísimo |
| **Organizar es renombrar y mover**, mucho | `rename` de primera clase, `prevPath`, y el `fileId` nativo de Drive valen más que la deduplicación por contenido |
| Estructura de **carpetas por sistema, artista o álbum**, a veces vacías | Registrar directorios en `vfs.json` no es un extra: hoy una carpeta vacía no se sincroniza |
| Ficheros de **cientos de MB** | El filtro `mtime`+`size` de v1 §4 deja de ser optimización y pasa a ser imprescindible: rehashear una ROM de 700 MB porque alguien la tocó cuesta una lectura completa |
| Colecciones de **miles de ficheros** que no cambian casi nunca | Un sync en reposo tiene que costar una lectura, no un recorrido (§5, §6) |

Un detalle que se sigue de los ficheros grandes: el `hash` de `vfs.json` **lo calcula siempre quien
escribe el fichero**, en local. Un peer remoto nunca puede verificar un hash sin descargarse el
contenido, así que se fía del que declara el otro — y por eso el hash recibido se comprueba al
escribir (§4), que es el único momento en que los bytes pasan por delante.

Lo que *no* preocupa: árboles con decenas de miles de ficheros en `vfs.json`. Un catálogo de 20.000
entradas son unos pocos MB de JSON, y con el digest `state` (§2) ni siquiera se lee en el caso normal.

## 1. `.vfs` en v2

```
.vfs/
  vfs.json                     # mutable: estado actual del árbol + cabecera
  commits                      # append-only: unión de operaciones, segmento activo
  commits-<ts>                 # segmentos cerrados, inmutables (§3)
  vfs-<ts>.json                # el árbol al cerrar cada segmento
```

Dos entradas en el camino normal, ninguna carpeta. Los pares `commits-<ts>` / `vfs-<ts>.json`
aparecen al rotar, son inmutables y sólo se leen en frío — nunca para decidir el estado de un
fichero, únicamente para evitar una copia de conflicto innecesaria (§4).

## 2. `vfs.json`

Es el espejo del árbol y lo único que un sync necesita leer para decidir.

```jsonc
{
  "version": 2,
  "storeId": "9f3c…",          // identidad del dataset; converge al menor lexicográfico
  "peer": "device-a",          // identidad de este nodo
  "state": "4a28fc…",          // digest de `entries` en orden canónico
  "log": {
    "segment": 1785102000000,  // rotación vigente; identifica el fichero activo
    "digest": "1f4a9c…",       // XOR de los `op` del segmento activo: ¿mismo conjunto?
    "rows": 412,
    "size": 51200,
    "snapshot": "vfs-1785102000000.json",   // el árbol en el momento de rotar
    "archives": [1784000000000, 1785102000000]   // segmentos cerrados, por si hay que mirar atrás
  },
  "peers": {
    "device-b": {
      "lastSync": 1785102021367,
      "segment": 1785102000000,  // hasta dónde leí, y de qué segmento
      "offset": 51200,
      "digest": "1f4a9c…"
    }
  },
  "local": {                   // sólo para este nodo; quien lo lea de fuera lo ignora
    "driveChangeToken": "8421",
    "verifiedAt": 1785102021367,
    "pendingRenames": []
  },
  "entries": [
    {
      "uuid": "b7c1…",
      "kind": "file",
      "path": "docs/getting-started.md",
      "hash": "68796a…",
      "size": 18,
      "created": 1785101000000,
      "updated": 1785102021367,
      "peer": "device-a",
      "prev": "0a11b2…",       // hash anterior: un paso de historia en línea
      "prevPath": "docs/start.md",
      "native": "1xP3rma92h5…" // fileId de Drive, cuando el backend lo da
    }
  ]
}
```

**Entradas planas, no anidadas.** El anidamiento no le sirve al motor —el emparejamiento y el merge
son por entrada— y complica el diff. El explorador ya reconstruye el árbol a partir de las rutas
(`buildTree`).

**Orden canónico** (por `path`, y por `uuid` a igualdad): dos peers convergidos producen `entries`
byte a byte idéntico. Eso es lo que hace que `state` sea comparable: **una sola comparación decide si
hay algo que sincronizar**, sin recorrer entradas.

**Registra directorios** (`kind: "directory"`). El tree de v1 sólo tenía ficheros, y de ahí sale un
agujero real: hoy **una carpeta vacía no se sincroniza** — creas la carpeta, sincronizas y no aparece
al otro lado. Si `vfs.json` va a ser el espejo del árbol, que lo sea del todo.

**`prev` y `prevPath`** son un paso de historia en línea, y sustituyen al ancestro: `prev` dice de qué
versión desciende ésta, y `prevPath` de dónde se movió. Con eso el merge resuelve contenido y
ubicación por separado igual que hoy, sin leer nada más.

**`native`** guarda el id del backend cuando existe (el `fileId` de Drive). Es lo que permite mapear
un cambio externo —la changes API devuelve `fileId`, no ruta— a una entrada. Sigue siendo el uuid la
identidad lógica.

**Qué viaja y qué no.** Todo el fichero se lee tal cual, pero `peers` y `local` son marcadores de
este nodo: quien lo lea de fuera los ignora. `hash-cache.json` desaparece porque `entries` ya lleva
`hash`+`size`+`updated` por ruta, que es exactamente el filtro de la sección 4 de v1.

## 3. `commits` — log append-only fusionado

Una fila por operación, un objeto JSON por línea, sin los corchetes de apertura y cierre y sin comas:
así el fichero se extiende **añadiendo**, y cada línea se parsea sola.

```
{"op":"7f3a…","batch":"c81f…","at":1785102021367,"peer":"device-a","uuid":"b7c1…","type":"write","kind":"file","path":"notes.md","hash":"68796a…","prev":"0a11b2…","size":29}
{"op":"9b02…","batch":"c81f…","at":1785102021368,"peer":"device-a","uuid":"e440…","type":"delete","kind":"file","path":"todo.md","prev":"7c9e…"}
```

- **`op`** — id de la operación, `sha256(peer|uuid|at|type|path|hash)`. Lo calcula quien la origina,
  es **independiente de la réplica**, y registrar dos veces la misma operación da el mismo id: la
  deduplicación por `op` es lo que hace que la unión sea idempotente.
- **`batch`** — agrupa las operaciones de un mismo guardado o de un mismo merge, para que la UI pueda
  decir "este sync movió 3 ficheros". Es la unidad que en v1 era un commit.
- **`type`** — `write` | `rename` | `delete`, etiqueta legible; los campos son la verdad (un `write`
  con `prev: null` es una creación; un cambio de `path` es un rename).

### Fusionar es unir

Las filas son inmutables e identificadas, así que fusionar dos logs es **unión de conjuntos**,
deduplicando por `op`. Ya existe el precedente en v1: `known-commits.log` es propios más aprendidos
de peers (`addKnown`), sólo que reescrito entero y ordenado en cada commit.

**Se añade en orden de llegada; se ordena en memoria.** Si el fichero tuviera que estar ordenado por
fecha, fusionar insertaría en el medio y habría que reescribirlo entero — perdiendo lo único que
queremos del append-only: que los offsets sean estables y la cola se pueda leer con `readRange` (en
Drive, un `Range:` HTTP). El disco cuenta "cuándo me enteré"; el orden real lo reconstruye quien lee.

Esto tiene una consecuencia que hay que respetar: **el log no depende de ningún peer**. La identidad
del peer va en la fila (`peer`), no en el nombre del fichero. Un log por peer parecía más limpio pero
es peor: A no tendría las operaciones de B al sincronizar con C, y con el log fusionado le llegan a
través de A. Además los dos lados deciden los conflictos con la misma información, que es lo que hace
la decisión determinista sin otra ronda.

### Cadena de hashes: descartada

Encadenar cada fila con la anterior (`id = sha256(idAnterior + fila)`) daría verificación incremental,
pero **no compone con un log fusionado**: el orden de llegada difiere en cada réplica, así que el id
de una fila dependería de quién la escribió y cuándo se enteró — y la deduplicación por id, que es la
que hace idempotente la unión, dejaría de funcionar.

En su lugar, dos marcadores en la cabecera con papeles distintos:

- **`log.digest`** — XOR de todos los `op`. Independiente del orden e independiente de la réplica, así
  que responde *"¿tenemos el mismo conjunto de operaciones?"* con una comparación. Si coincide con el
  que anoté de ese peer, **no leo su log**.
- **`log.size` / `log.rows`** — detectan crecimiento y truncamiento. El tamaño lo da el listado (que
  ya trae `size`) o un `stat`.

Caveat del XOR: no es un digest de multiconjuntos robusto — un `op` insertado dos veces se cancela.
Depende de que la deduplicación por `op` sea correcta, que es invariante que necesitamos igual.
Alternativa si algún día molesta: suma módulo 2²⁵⁶, también incremental y sin ese defecto.

### Rotar por segmentos

El log crece para siempre, así que se **rota**: cuando el fichero activo pasa de un umbral, se
renombra a `commits-<timestamp>`, se guarda una **foto del árbol** en ese momento
(`vfs-<timestamp>.json`) y el nuevo `commits` arranca vacío referenciando las dos cosas.

```
.vfs/
  vfs.json
  commits                      # activo, acotado
  commits-1785102000000        # archivo, inmutable
  vfs-1785102000000.json       # el árbol tal como estaba al cerrar ese segmento
```

Esto no es sólo higiene, es lo que hace el log viable en Drive: **añadir allí es subir el fichero
entero**, así que sin rotación cada sync reenvía toda la historia — el problema exacto que tiene hoy
`known-commits.log`. Con rotación, lo que se resube está acotado por el umbral.

**El orden importa: rotar y fotografiar primero, podar tombstones de `vfs.json` después.** Así la
foto siempre contiene lo que `vfs.json` deja de contener, que es justo lo que hace falta para no
resucitar un borrado (§4).

Y subsume la compactación: la foto lleva el último estado de **todos** los `uuid` conocidos, así que
el segmento activo puede empezar de cero sin invariantes que respetar. De paso desaparece el conflicto
entre compactar y unir: **las filas anteriores a mi foto se pueden ignorar al fusionar**, porque el
estado vivo llega por las entradas de `vfs.json` y lo que yo sabía está en la foto. El `segment` hace
el papel que iba a hacer `epoch`: si el peer rotó, mi offset ya no aplica y leo el segmento nuevo
desde el principio.

### Un escritor por store

Añadir de verdad sólo existe en algunos backends: nativo en node (`'a'`) y en OPFS/FSA
(`createWritable({ keepExistingData: true })` + seek); en Drive hay que subir el fichero entero. Con
un único fichero compartido, dos escritores concurrentes pierden filas (gana el último). No es una
regresión —`known-commits.log` tiene hoy la misma exposición— pero la mitigación es explícita:
**comparar `size`/`rows` con lo que tengo antes de añadir**, y si el fichero creció por debajo, releer
la cola, fusionar y entonces añadir.

### Para qué hace falta el log, exactamente

Vale la pena delimitarlo, porque de ello depende cuándo hay que leerlo:

| para | ¿imprescindible? |
| --- | --- |
| Converger el contenido de un fichero que ambos lados tienen | **No** — LWW sobre `vfs.json` basta |
| Distinguir un conflicto real de una propagación (§4) | No: sin log se asume conflicto y se guarda copia |
| Historia legible por el usuario | No |
| **Saber que una entrada ausente es un borrado y no una novedad** (§4) | **Sí**, si se podan tombstones |

Las tres primeras degradan bien: el peor fallo es *"guardo una copia de conflicto que no hacía
falta"*. La cuarta es correctitud, y es la razón por la que el segmento activo va acompañado de su
foto (§3): lo que el segmento no alcanza, lo alcanza la foto, y ninguna de las dos cosas se poda.

## 4. Merge

Reemplaza las secciones 5, 6 y 7 de v1. Se conserva la regla acordada allí — **gana el `updated` más
reciente, con el hash como desempate para que los dos lados decidan igual** — y se conserva que
contenido y ubicación se resuelven por separado.

**Emparejamiento**: por `uuid`. Cuando dos peers descubrieron el mismo fichero por separado y tienen
uuids distintos, se cae a `path` y uno de los dos uuid gana y se propaga (igual que hoy, §3 de v1).

Por cada entrada emparejada:

| caso | resultado |
| --- | --- |
| sólo un lado la tiene, el otro tiene tombstone | decide `updated`: tombstone más nuevo → se borra |
| sólo un lado la tiene, y en el otro no hay ni entrada ni tombstone | **mirar el segmento activo y su foto** por ese `uuid`: si lo último que dicen es un `delete` más nuevo, se borra; si no lo conocen, es nueva y se toma |
| ambos, mismo `hash` | no hay conflicto; gana el `updated` mayor para los metadatos |
| ambos, `hash` distinto | gana el `updated` mayor (desempate por `hash`) |
| `deleted` en un lado, editada en el otro | LWW; si gana el borrado y había contenido en riesgo, copia |

**Detección de conflicto sin ancestro.** Cuando los hashes difieren hay que distinguir "el otro va un
paso por detrás" de "los dos editaron". El perdedor es antepasado del ganador si:

1. `ganador.prev === perdedor.hash` — el caso normal, sin leer nada; o
2. el hash del perdedor aparece antes en el segmento activo para ese `uuid`; o
3. la foto del segmento (que también lleva `prev`) lo confirma un paso más atrás.

Si ninguna de las tres, es conflicto real → **se conserva el perdedor como copia** (`notes (conflict
device-b 1f4a9c2e).md`, misma convención que hoy).

### Cuándo hace falta un archivo

Esta es la única pregunta que puede necesitar mirar hacia atrás, y la respuesta es acotada:

| pregunta | ¿basta el segmento activo + su foto? |
| --- | --- |
| ¿esta entrada ausente es un borrado? | **Sí, siempre** — la foto lleva el último estado de todos los `uuid` que existían al rotar |
| ¿el perdedor desciende del ganador? | Sí, si su versión es posterior a la rotación. Si es anterior, el archivo lo sabría |

O sea: **un archivo nunca hace falta para decidir el estado, sólo para evitar una copia de conflicto
que no hacía falta.** Y se sabe cuándo mirarlo sin abrirlo: si el `updated` del perdedor es anterior
al `segment` vigente, la respuesta está en el archivo cuyo rango de tiempo lo cubre (el nombre lleva
el timestamp, y `log.archives` da la lista ordenada). Si no se quiere pagar esa lectura, se asume
conflicto y se guarda la copia — degradación segura, y con esta carga de trabajo (§0) rarísima.

Los archivos son inmutables: se leen en frío, se pueden cachear para siempre y nunca se reescriben.

**Ubicación.** Si las rutas difieren, `prevPath` dice quién movió el fichero: si
`ganador.prevPath === perdedor.path`, el ganador lo movió y su ruta manda. Si ninguno de los dos
`prevPath` explica el movimiento, los dos lo movieron → LWW por `updated`.

**Borrados.** Un borrado deja dos rastros, y el importante es el segundo:

1. una entrada con `deleted: true` y su `updated` en `vfs.json` — el **atajo**, que responde sin leer
   nada más;
2. una fila `type: "delete"` en el log, con su `at` — el **registro durable**.

La fila es la prueba: su fecha demuestra que el borrado es posterior a la versión que trae un peer
desactualizado. Así que el tombstone de `vfs.json` **no tiene que ser eterno** — se puede podar, y la
decisión sigue siendo correcta consultando el log. Regla: cuando un lado tiene una entrada que el otro
no tiene, hay que buscar el `uuid` en el log antes de darla por nueva.

```
C (offline desde t=50) tiene X con updated=50
A borró X en t=100, y ya podó el tombstone de vfs.json

sin log:  A no tiene X, C sí → se toma → X resucita
con log:  última fila de X = delete@100 > 50 → se borra en C ✓
```

Eso mueve el estado no acotado —"todo lo que existió alguna vez"— del fichero que se lee **entero en
cada sync** a la foto de la rotación, que sólo se abre cuando hay una entrada ausente que explicar. No
se puede eliminar (olvidar un borrado es incorrecto en una malla de membresía abierta), pero sí se
puede pagar mejor.

**Y aquí la rotación (§3) sustituye a cualquier invariante de poda**: la foto lleva el último estado
de todos los `uuid` que existían al cerrar el segmento, tombstones incluidos. Mientras se rote *antes*
de podar `vfs.json`, la resurrección es imposible por construcción — no hay una regla que recordar al
compactar, porque no se compacta: se cierra un segmento y se guarda la foto.

Queda un caso que ningún registro arregla, y es el de siempre: **relojes desfasados**. Si el peer
desactualizado trae `updated: 150` porque su reloj va adelantado, gana su versión viva sobre un
borrado real de t=100 y el fichero resucita igual. Es el riesgo ya advertido en la sección 7 de v1, y
aquí al menos falla hacia el lado seguro: conserva datos en vez de perderlos.

**Integridad al recibir.** En v1, `putObjectStreamAt` re-hashea lo que escribe: *"una transferencia
truncada no puede aterrizar como objeto válido"*. Al quitar el direccionamiento por contenido eso
desaparece, así que hay que **re-hashear el fichero recibido contra el hash esperado**, que está en
`vfs.json`. Es local y barato, y sin él una subida truncada se convierte en "la versión más nueva".

**Copias de conflicto sin blobs.** El perdedor ya no se fija en `objects/`: antes de sobrescribir el
fichero de trabajo, se copia a su ruta de conflicto. Un rename en vez de `materialize()`.

## 5. Protocolo de sync entre dos peers

Reemplaza la sección 8 de v1. No hay negociación de ancestro.

1. **Leer** `vfs.json` del otro peer — 1 lectura.
2. **`storeId`**: ambos adoptan el menor lexicográfico (igual que hoy).
3. **`state`**: si su digest coincide con el mío, no hay nada que hacer. Fin.
4. **Merge de entradas** en memoria (§4) → por fichero: nada / traer / enviar / conflicto.
5. **Log**, cuando hace falta: si `log.digest` difiere del que anoté, leer desde `peers[x].offset` — o
   el segmento entero desde cero si su `log.segment` no es el que tengo anotado, porque rotó — y unir.
   Hace falta en dos casos, no sólo uno:
   - **una entrada existe en un lado y no en el otro** → hay que buscar su `uuid` en el segmento y en
     su foto antes de darla por nueva, porque puede ser un borrado cuyo tombstone ya se podó (§4);
   - hay **conflictos** que clasificar (¿propagación o edición simultánea?), y sólo aquí puede
     hacer falta abrir un archivo — nunca para decidir el estado.
6. **Transferir el contenido**: leer el fichero de trabajo del lado que gana y escribirlo en el otro,
   **re-hasheando al llegar**. Los conflictos escriben además su copia.
7. **Cerrar**: añadir a cada log las filas que le falten, actualizar `log.*` y `peers.*`, y escribir
   los dos `vfs.json`.

Un sync en reposo es el paso 1 y el paso 3: **una lectura por peer**. El log sólo entra en juego
cuando los conjuntos de entradas difieren, que es cuando algo ha pasado de verdad.

## 6. Leer una carpeta vFS sin recorrerla

Con `vfs.json` leído, el árbol de directorios se pinta entero —con tamaños, fechas y hashes— sin
recorrer nada. Es el ahorro más grande del rediseño: abrir una pestaña pasa de una llamada por
carpeta a una lectura.

Pero es espejo **de lo que escribió el motor**, no del disco: en cuanto algo escribe por fuera (la web
de Drive, el cliente de escritorio, Finder, otra app) `vfs.json` deja de ser exacto y no hay forma de
saberlo sin mirar. La separación:

- **Pintar** desde `vfs.json`, siempre.
- **Reconciliar** donde ya es obligatorio: el scan previo a un commit o a un sync recorre el disco de
  todas formas, más el botón de refresco. `local.verifiedAt` guarda cuándo fue la última vez.

Con una consecuencia que la UI tiene que asumir: el estado por fichero (*modified* / *untracked*) **no
se puede conocer sin tocar el disco**. En la primera pintada todo sale como registrado, y las filas
que difieran se marcan al reconciliar. Eso hay que mostrarlo ("verificado hace X"), porque si no un
fichero editado por fuera aparece como si estuviera al día.

## 7. `/drive/v3/changes` — espejo autorreparable

Ya estaba apuntado en la sección 1 de v1 y ahora es la pieza que hace confiable el espejo: en **una**
petición dice si algo cambió, en vez de O(carpetas).

```
GET /drive/v3/changes/startPageToken            → { startPageToken }      (una vez)

GET /drive/v3/changes
      ?pageToken=<token>
      &pageSize=1000
      &spaces=drive
      &restrictToMyDrive=true
      &fields=newStartPageToken,nextPageToken,
              changes(fileId,removed,file(id,name,parents,mimeType,size,modifiedTime,trashed))
```

- El token se guarda en `local.driveChangeToken`; cada respuesta trae `newStartPageToken` cuando se
  llega al final, y ése es el que se persiste.
- **No se puede filtrar por carpeta**: el feed es de la cuenta. Se filtra en cliente por
  `file.parents` contra las carpetas que conocemos, y por `fileId` contra los `native` de `entries`
  — que es justo para lo que sirve ese campo. Un cambio en una subcarpeta que nunca hemos resuelto no
  se puede atribuir y se ignora hasta el siguiente recorrido: caveat honesto.
- **Nuestros propios cambios también aparecen** en el feed. Hay que descartarlos comparando contra
  `entries` (mismo `hash`/`size`/`updated`), o cada escritura nuestra parecerá un cambio externo.
- **El token caduca**: Drive responde `410 Gone` si se queda demasiado atrás. La salida es pedir un
  `startPageToken` nuevo y hacer un recorrido completo — el camino de siempre, que sigue existiendo.
- **Scope**: hay que verificar el comportamiento del feed con `drive.file` (per-file access). Si sólo
  reporta ficheros creados por la app, sirve igual para lo nuestro; si no, requiere scope `drive`. Es
  una optimización, así que el fallback es el recorrido y no bloquea nada.

## 8. Cambios en el contrato de adaptadores

Dos métodos opcionales más, con la misma filosofía que el trío de streaming: si el backend lo hace
mejor, se implementa; si no, se emula.

| método | nativo | emulado |
| --- | --- | --- |
| `append?(path, data)` | node `'a'`; OPFS/FSA `keepExistingData` + seek | leer, concatenar, escribir |
| `changes?(token)` | Drive `changes.list` | ninguno: sin él, se recorre |

Lo que ya está y v2 usa tal cual: `readRange` (leer la cola del log), y el `stat` opcional en las
entradas de `list()` — que es lo que permite reconciliar una carpeta con una sola petición.

## 9. Qué se pierde

- **Contenido histórico**: no se puede recuperar una versión anterior. De facto ya era así — no hay
  API de restore, y los blobs antiguos ya no viajan en v1 (*"blobs stay on demand"*).
- **Deduplicación** entre ficheros de contenido idéntico: dos copias son dos transferencias.
- **El DAG**: no hay `log()` de commits ni "¿es A antepasado de B?" a nivel de repositorio. El log
  fusionado da la historia por fichero, que es la que se muestra.

## 10. Riesgos

1. **Espejo obsoleto** (§6): se mitiga con reconciliación explícita, `verifiedAt` visible y la changes
   API donde exista.
2. **Rotar sin foto, o podar `vfs.json` antes de fotografiar** (§3, §4): es lo único que puede
   resucitar un fichero borrado, y es una invariante de código, no una política. Hay que probarla con
   un test: rotar, podar, y comprobar que un peer viejo con el fichero vivo sigue viendo el borrado.
3. **Un escritor por store** (§3): comparar `size`/`rows` antes de añadir.
4. **XOR como digest de conjuntos** (§3): depende de la deduplicación por `op`.
5. **Desfase de relojes**: ya advertido en la sección 7 de v1, y v2 lo hereda intacto — el `updated`
   es una fecha lógica que viaja sin tocarse, y la copia de conflicto es la red de seguridad. Es
   también la única forma que queda de resucitar un borrado: un peer con el reloj adelantado gana a
   un borrado real. Falla hacia conservar datos.
6. **Acumulación de segmentos**: cada rotación deja un par de ficheros inmutables. No molestan al
   funcionamiento —nunca se listan ni se leen en el camino normal— pero `.vfs` acumula ficheros con
   los años. Es la contrapartida de tener el fichero activo acotado, y se puede fusionar archivos
   viejos en frío si algún día estorba.

## 11. Plan por fases

1. **Formato**: leer y escribir `vfs.json` y `commits` (orden canónico, digests, unión, offsets), más
   la rotación por segmentos con su foto (§3) y el test que fija el orden: rotar, podar, y comprobar
   que un peer viejo con el fichero vivo sigue viendo el borrado.
2. **Merge**: adaptar `merge.ts` — se conserva la resolución en dos dimensiones y se sustituye el
   ancestro por `prev`/`prevPath`. Los tests de `merge.test.ts` se traducen caso por caso, y hay uno
   nuevo que no existe hoy: entrada ausente con tombstone podado (§4).
3. **Sync**: reescribir `sync.ts` con el protocolo de §5. `sync.test.ts` y `engine-edges.test.ts`
   deberían pasar casi sin tocarse: describen comportamiento, no formato.
4. **Nodo**: `VFSNode` deja de tener store de objetos; `VFSStore` se reduce a la E/S de los dos
   ficheros. Se borran `objects/`, `commits/*.json`, `known-commits.log`, `hash-cache.json`, el modo
   `reconstruct` y todo `materialize*`.
5. **Explorador**: pintar desde `vfs.json`, reconciliar aparte (§6). La vista perezosa de `.vfs` que
   hay hoy se simplifica hasta desaparecer — con dos entradas no hay nada que paginar.
6. **Drive**: `changes?` en el adaptador y el ciclo de reconciliación incremental (§7).
7. **Adaptadores**: `append?` con su emulación, y el contrato al día en `docs/adapters.md`.

## Decisiones abiertas

- **Unidad de `batch`**: ¿una por guardado del usuario, una por sync, o ambas cosas distinguidas por
  `type`? Recomendación: una por guardado y una por merge, que es como lo lee la UI hoy.
- **Cuándo podar un tombstone de `vfs.json`**: en cuanto todos los peers conocidos lo han visto
  (`peers[*].lastSync` posterior al borrado) es lo más agresivo que se puede hacer sin perder nada,
  porque el log cubre al peer que reaparece. ¿Basta con eso, o se mantiene una ventana por si acaso?
- **Umbral de rotación**: es literalmente "cuánto estoy dispuesto a resubir en cada sync", porque en
  Drive añadir es reescribir el segmento activo. Con esta carga de trabajo (§0) yo empezaría por
  **256 KB**, y rotaría además tras una importación masiva en lugar de esperar al umbral — al importar
  un catálogo entero se generan miles de filas de golpe.
- **Índice del log por `uuid`**: se construye leyendo el segmento activo y su foto, así que la primera
  consulta de un borrado podado cuesta esa lectura. ¿Se persiste el índice en `local` para no repetirlo
  entre sesiones, o se acepta el coste la primera vez que hace falta?
- **Estado verificado por entrada**: ¿`verifiedAt` global (simple) o por entrada (permite marcar
  *modified* sólo en lo que se ha comprobado)?
- **`drive.file` y la changes API**: verificar antes de contar con ella (§7).
- **Tamaño de `vfs.json`** en árboles de decenas de miles de ficheros: se lee entero en cada sync, y
  ahora sólo contiene entradas vivas más tombstones recientes. ¿Hace falta acotarlo de alguna otra
  forma, o el `state` digest ya evita leerlo en el caso normal?
