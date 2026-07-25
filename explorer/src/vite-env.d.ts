// Vite exposes build-time env under import.meta.env. Only the vars the app
// actually reads are declared; tsc needs the shape, Vite supplies the values.
interface ImportMetaEnv {
  /** Public OAuth client id for the Google Drive backend. Optional. */
  readonly VITE_GDRIVE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
