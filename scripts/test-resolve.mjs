// `node --import ../../scripts/test-resolve.mjs …`: makes a test run resolve the
// harness peers (`@deepseek-ai/dsh-session`, `@deepseek-ai/cordis-plugin-im-core`,
// …) from the harness checkout, exactly as the deployed profile resolves them
// through the harness's own node_modules.
import { register } from 'node:module'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { harnessRoot } from './harness-root.mjs'

register('./harness-resolve-hooks.mjs', import.meta.url, {
  data: { root: pathToFileURL(join(harnessRoot(), sep)).href },
})
