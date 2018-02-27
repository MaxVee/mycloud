import fs = require('fs')
import path = require('path')
import nunjucks = require('nunjucks')

type Render = (args:any) => string

interface IAction {
  text: string
  href: string
}

interface IContentBlock {
  body: string
}

interface IActionEmailArgs {
  action: IAction,
  blocks: IContentBlock[]
  signature: string
  twitter: string
}

type RenderActionEmail = (args:IActionEmailArgs) => string
type Templates = {
  [name: string]: Render
}

type AllTemplates = {
  [category: string]: Templates
}

const nunjucksConf = {
  autoescape: true,
  cache: true
}

const baseDir = path.join(__dirname, '../../assets/in-house-bot/templates/prerendered')
const env = {
  email: nunjucks.configure(path.join(baseDir, 'emails'), nunjucksConf)
}

const withAutoEscape = nunjucks.configure({
  autoescape: true
})

const withoutAutoEscape = nunjucks.configure({
  autoescape: false
})

export const email:Templates = {
  action: (data:IActionEmailArgs) => env.email.render('action.html', data)
}

export const renderString = withAutoEscape.renderString.bind(withAutoEscape)
export const renderStringNoAutoEscape = withoutAutoEscape.renderString.bind(withoutAutoEscape)

// console.time('render')
// const html = email.action({
//   action: {
//     text: 'Launch MyCloud',
//     href: 'launchUrl'
//   },
//   blocks: [
//     { body: 'Hi there,' },
//     { body: 'Click below to launch your Tradle MyCloud' }
//   ],
//   signature: 'Tradle Team',
//   twitter: 'tradles'
// })

// console.timeEnd('render')