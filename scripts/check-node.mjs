// Plain JavaScript on purpose: this must run on any Node version so it can
// explain why the rest of the project cannot. Wired in as `prestart`/`pretest`.
const [major, minor] = process.versions.node.split('.').map(Number);
const ok = major > 22 || (major === 22 && minor >= 13);
if (!ok) {
  console.error(`
This project needs Node.js 22.13 or newer (24 recommended); you are on ${process.version}.

It relies on two built-in features so that nothing has to be installed:
  - node:sqlite                 (built in since 22.13)
  - TypeScript type stripping   (22.6+ behind --experimental-strip-types, which the
                                 npm scripts pass; default since 22.18)

  nvm:    nvm install 24 && nvm use          (an .nvmrc is included)
  docker: docker build -t ottodot . && docker run -p 3000:3000 ottodot
`);
  process.exit(1);
}
