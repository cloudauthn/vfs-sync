// Vite exposes build-time env under import.meta.env. Only the vars the app
// actually reads are declared; tsc needs the shape, Vite supplies the values.
interface ImportMetaEnv {
  /** Public OAuth client id for the Google Drive backend. Optional. */
  readonly VITE_GDRIVE_CLIENT_ID?: string;
  /** OAuth scope for Drive; defaults to drive.file. Set to .../auth/drive to browse all of My Drive. */
  readonly VITE_GDRIVE_SCOPE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
