
import * as Templates from './templates'
import { Bot, IMailer, IInvite, IConf } from './types'

export interface IInviterConf {
  senderEmail: string
}

type InviterOpts = {
  bot: Bot
  orgConf: IConf
  conf: IInviterConf
}

export class Inviter {
  private bot: Bot
  private orgConf: IConf
  private conf: IInviterConf
  constructor({
    bot,
    orgConf,
    conf
  }) {
    this.bot = bot
    this.orgConf = orgConf
    this.conf = conf
  }

  public sendInvite = async (invite: IInvite) => {
    const {
      subject,
      body,
      recipients,
      inviteLink,
      buttonText,
      signature=`${this.orgConf.org.name} team`
    } = invite

    const blocks = body
      .split('\n')
      .filter(line => line.trim().length)
      .map(line => ({ body: line }))

    const action = inviteLink && buttonText && {
      href: inviteLink,
      text: buttonText
    }

    const html = Templates.email.action({ blocks, action, signature })

    await this.bot.mailer.send({
      from: this.conf.senderEmail,
      to: recipients,
      subject,
      body: html,
      format: 'html'
    })
  }
}

export const createInviter = (opts:InviterOpts) => new Inviter(opts)
