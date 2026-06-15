set -eo pipefail

runHook preBuild

npm run --workspace @earendil-works/pi-tui build
node_modules/.bin/tsgo -p packages/ai/tsconfig.build.json
npm run --workspace @earendil-works/pi-agent-core build
npm run --workspace @earendil-works/pi-coding-agent build

runHook postBuild
