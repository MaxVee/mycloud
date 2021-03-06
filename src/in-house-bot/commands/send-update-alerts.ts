import { ICommand } from '../types'

export const command:ICommand = {
  adminOnly: true,
  name: 'send-update-alerts',
  examples: [
    '/send-update-alerts',
    '/send-update-alerts --tag <tag>',
  ],
  description: 'send update alerts to friends',
  exec: async ({ ctx, commander, req, args }) => {
    const { tag='latest' } = args
    await commander.deployment.alertChildrenAboutVersion({ tag })
  }
}
