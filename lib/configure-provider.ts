const debug = require('debug')('tradle:sls:config')
import * as validateResource from '@tradle/validate-resource'
import { buckets, constants, models } from '../'
const { PUBLIC_CONF_BUCKET } = constants
const KEY = PUBLIC_CONF_BUCKET.info

export async function setStyle (style) {
  debug('setting style', JSON.stringify(style, null, 2))

  validateResource({
    models,
    model: 'tradle.StylesPack',
    resource: style
  })

  const info = await buckets.PublicConf.getJSON(KEY)
  info.style = style
  await buckets.PublicConf.putJSON(KEY, info)
}
