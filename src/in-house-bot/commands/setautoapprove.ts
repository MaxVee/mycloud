import yn = require('yn')
import parse = require('yargs-parser')
import { setProperty } from '../utils'
import { ICommand } from '../types'

export const command:ICommand = {
  name: 'setautoapprove',
  examples: [
    '/setautoapprove',
    '/setautoapprove false'
  ],
  description: 'toggle whether verifications are issued automatically for forms',
  parse: (argsStr:string) => {
    const args = parse(argsStr)
    return {
      value: yn(args._[0] || true)
    }
  },
  exec: async function ({ commander, req, args }) {
    const { value } = args
    const path = 'products.autoApprove'
    await setProperty({ commander, req, path, value })
    commander.logger.debug(`set ${path} to ${value}`)
    await commander.sendSimpleMessage({
      req,
      to: req.user,
      message: `Done. Give me ~30 seconds to process this doozy.`
    })
  }
}