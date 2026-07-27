# VFS Sync — Diseño de sincronización multi-peer (OPFS / File System Access API / Google Drive)

> Este es el diseño de lo que está implementado hoy. [`design-v2.md`](./design-v2.md) propone
> sustituir sus secciones 3, 5, 6, 7 y 8: `.vfs` de dos ficheros, sync por metadatos y sin almacén
> de blobs. Las secciones 1, 2 y 4 siguen vigentes en v2.

## Objetivo

Mecanismo de sincronización de carpetas entre cualquier combinación de proveedores:
- OPFS
- File System Access API (sistema de archivos local, vía navegador)
- Google Drive (eventualmente)

Debe soportar **cualquier combinación** de peers, incluyendo cadenas de varios nodos
(ej. `OPFS <-> FS local <-> FS local <-> GDrive`), no solo pares fijos.

Pensado como parte reutilizable del SDK **cloudauthn** (junto con la parte de
WebAuthn/passkeys), para usar en `play.germade` y `MusikMatch`.

## Modelo general: mesh, no hub-and-spoke

Todos los nodos actúan como pares entre sí. Cada nodo solo conoce a los peers con los
que tiene una relación de sync **directa** — no hay conocimiento global del grafo ni de
"peers de mis peers". La propagación en cadenas largas ocurre porque cada arista corre
su propio ciclo de sync de forma independiente y periódica.

## 1. Capa de abstracción: VFSAdapter

Interfaz común que implementa cada backend:

```
list(path)
read(path)
write(path, data)
delete(path)
rename(oldPath, newPath)   // operación de primera clase, no solo write+delete
stat(path)                 // mtime, size
```

Adaptadores necesarios:
- **OPFS**: `FileSystemDirectoryHandle` / `FileSystemFileHandle`, `createSyncAccessHandle`
  desde worker para acceso síncrono.
- **File System Access API**: mismo modelo de handles (`showDirectoryPicker`), con el
  matiz de que los permisos expiran y hay que volver a solicitarlos
  (`requestPermission`) — complica la sync automática en background.
- **Google Drive**: API REST (`files.list`, `files.get`, `files.create/update`),
  `changes.list` + `pageToken` para sync incremental. Drive da un `fileId` estable
  (ver sección de identidad).

Empezar por OPFS y FSA (no dependen de OAuth); Drive se añade después sin tocar el motor.

## 2. Carpeta de control `.vfs`

Vive dentro de cada carpeta sincronizada, igual que `.git`. Debe **excluirse del diff**
de contenido (si no, cada motor la trataría como archivo normal a sincronizar).

```
.vfs/
  config.json              # id único del nodo, lista de peers conocidos
  objects/<hash[0:2]>/<hash>   # blobs y trees, content-addressed
  commits/<commit_hash>.json   # {tree, parents[], timestamp, peer}
  known-commits.log         # índice plano: <hash> <timestamp> <parent(s)>
  hash-cache.json           # {path: {hash, mtime, size}} — caché local de hashes
```

> Nota: se simplificó el diseño eliminando `refs/<peer-id>` (puntero directo al último
> commit en común con cada peer). Se decidió usar un único mecanismo —
> `known-commits.log` — tanto para peers ya conocidos como para el primer encuentro
> con un peer nuevo, en vez de mantener dos rutas distintas.

### `known-commits.log`
Índice plano de todos los commits que el nodo conoce (los propios + los aprendidos de
otros peers al sincronizar). Convierte la búsqueda de ancestro común en una
intersección de conjuntos (`misCommits ∩ susCommits`) en vez de recorrer el DAG
objeto a objeto. Es el único mecanismo de negociación de ancestro común, tanto con
peers ya conocidos como con peers nuevos. Análogo al `commit-graph` de git moderno:
acelera la negociación sin cambiar el modelo de datos.

## 3. Modelo de commits (estilo git)

- **Blob**: contenido de archivo, direccionado por `hash(contenido)`. Dedup automático
  entre archivos/peers con el mismo contenido.
- **Tree**: snapshot de la carpeta — lista de entradas `{id, path, hash, deleted,
  renamed_from}`.
- **Commit**: `{tree_hash, parents[], timestamp, peer_id}`. Un commit con dos padres
  representa un merge entre dos peers.

### Identidad de archivo (`id`)

El diff no se hace solo por `path` — cada archivo tiene una identidad que sobrevive a
renames:
- **Drive**: usa el `fileId` nativo, estable ante renames sin necesidad de heurística.
- **OPFS / FSA**: no hay id nativo → identidad sintética generada por el propio nodo.
  - Se asigna la primera vez que un path se "descubre" (aparece sin id asignable ni por
    continuidad de path ni por evento de rename ni por heurística de hash).
  - Se conserva mientras el archivo exista, incluyendo tras renames.
  - **Caso de reconciliación**: dos peers que descubren el mismo archivo de forma
    independiente (sin sync previo entre ellos) le asignan ids distintos. En su primer
    encuentro, el emparejamiento no puede basarse en id — cae de vuelta a comparar por
    `path`/hash, y uno de los dos ids "gana" y se propaga como canónico de ahí en
    adelante.

## 4. Detección de cambios y filtro de coste

Para evitar hashear todo en cada sync:

1. **Filtro rápido**: comparar `mtime` + `size` contra `hash-cache.json`.
   - Si coinciden con lo cacheado → se asume que el hash guardado sigue siendo válido,
     no se relee el archivo.
   - Si difieren → el archivo cambió localmente → se recalcula el hash y se actualiza
     la caché.
2. El hash resultante es el que entra en el `tree` del commit (content-addressed).

`hash-cache.json` es **local a cada peer** (no se sincroniza); lo que viaja entre peers
son los hashes ya resueltos dentro de los trees/commits.

## 5. Borrados

Se representan como tombstone explícito en el tree, no como ausencia:

```json
{ "id": "...", "path": "...", "hash": null, "deleted": true, "mtime": "<momento del borrado>" }
```

- El tombstone se conserva en el histórico (no se purga enseguida) — un peer nuevo que
  no vio el borrado necesita verlo para no asumir "nunca existió".
- Borrado en un lado + edición en el otro desde el ancestro común → conflicto real,
  resuelto con la misma regla de timestamp (ver sección 7).

## 6. Renames

Se registran explícitamente en el tree, no solo se infieren:

```json
{ "id": "...", "path": "<nuevo>", "hash": "...", "deleted": false, "renamed_from": "<anterior>" }
```

- **Por qué explícito y no solo heurística por hash**: evita ambigüedad cuando hay
  contenido duplicado (mismo hash en dos archivos), y deja historial navegable
  ("esto se renombró de X a Y en este commit").
- **Drive**: el adaptador lo detecta con certeza total vía `fileId` estable.
- **OPFS/FSA**: el propio VFS debe exponer `rename()` como operación de primera clase
  para capturar la intención en el momento en que ocurre. La heurística por hash
  (mismo hash, path distinto) queda como red de seguridad para cambios que llegaron
  por fuera del VFS (ej. el usuario renombra el archivo directamente en el Finder).

## 7. Resolución de conflictos

Regla acordada: **cuando el hash confirma que el contenido difiere realmente, gana la
versión con el timestamp (mtime) más reciente.**

Flujo completo por archivo, en cada arista de sync:

1. Filtro mtime+size → ¿cambió algo desde el ancestro común?
2. Si cambió en ambos lados → comparar hash.
   - Hash igual → mismo contenido, no hay conflicto real.
   - Hash distinto → conflicto real → gana el mtime más reciente.
3. Se genera un commit nuevo con dos padres representando el estado conciliado.

**Riesgo a vigilar**: desfase de reloj entre peers puede hacer "ganar" a una edición
que en realidad es anterior en tiempo real. Mitigación sugerida: conservar siempre la
versión perdedora como copia de conflicto (ej. `archivo (conflicto, peer-C,
2026-07-24).ext`) en vez de descartarla silenciosamente — especialmente importante
para binarios (ROMs, assets), donde no cabe merge línea a línea.

## 8. Algoritmo de sync entre dos peers (resumen)

1. Negociar ancestro común: intersección de `known-commits.log` de ambos peers
   (`misCommits ∩ susCommits`) → commit base más reciente en común.
2. `diff(base.tree, A.tree)` y `diff(base.tree, C.tree)` por `id` (fallback a `path`
   si no hay match de id, ver sección 3).
3. Clasificar cada entrada: solo-A, solo-C, ambos-igual (mismo hash), conflicto real
   (hash distinto).
4. Aplicar cambios no conflictivos en ambas direcciones.
5. Resolver conflictos por timestamp (sección 7), conservando la versión perdedora
   como copia si se quiere evitar pérdida silenciosa.
6. Generar commit de merge con ambos padres, añadirlo a `known-commits.log` en
   ambos nodos.

## Pendiente / siguientes pasos

- Definir formato JSON exacto de `tree` y `commit` (campos finales, tipos).
- Prototipar `VFSAdapter` para OPFS y para FSA.
- Prototipar el motor de diff/merge genérico, probable con adaptadores en memoria antes
  de los reales.
- Evaluar necesidad de garbage collection sobre `objects/` (blobs/trees no alcanzables
  desde ningún ref).
- Añadir adaptador de Google Drive cuando el resto esté validado.
