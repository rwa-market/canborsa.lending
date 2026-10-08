/// <reference types="vite/client" />

/** Frontend build variables. All public: they end up in the bundle, no secrets here. */
interface ImportMetaEnv {
  /** Expected wallet network (CIP-0103 networkId); must match the backend /config */
  readonly VITE_EXPECTED_NETWORK_ID?: string
  /** Protocol operator party; must match the backend /config */
  readonly VITE_OPERATOR_PARTY?: string
  /** Build label in the footer; short git hash by default */
  readonly VITE_BUILD_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
