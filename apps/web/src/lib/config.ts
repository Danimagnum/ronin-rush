/**
 * Where the browser reaches the API. Set to an absolute URL in development (the API runs on its
 * own port); leave it empty behind a reverse proxy that serves /api and /socket.io on the same
 * origin as the web app (Docker Compose, Kubernetes ingress).
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/** Play money is counted in ryō — an old Japanese gold coin — so nobody mistakes it for real currency. */
export const CURRENCY = 'ryō';
