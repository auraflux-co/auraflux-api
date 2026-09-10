# AuraFlux marketing site (auraflux.co)

Vercel project: **`auraflux-co`** on team **`robert-4220s-projects`** (CLI user `robert-4220`).

DNS stays on **Cloudflare**. Hosting is Vercel. Point apex (and www) with Cloudflare CNAME flattening to Vercel’s target (`cname.vercel-dns.com` or the value shown in the Vercel domain UI).

## Develop / ship

```bash
cd marketing
python3 scripts/build-static.py
npx vercel whoami   # must be robert-4220
npx vercel deploy --prod --yes --scope robert-4220s-projects
```

Sources live in this folder (`pages/`, `framer-shell/`, `content/`). Mirror of the former Cloudflare Pages worker content. DNS stays on Cloudflare; hosting is Vercel project **`auraflux-co`**.
