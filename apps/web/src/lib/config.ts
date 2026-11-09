export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/** Play money is counted in ryō — an old Japanese gold coin — so nobody mistakes it for real currency. */
export const CURRENCY = 'ryō';
