import { ICommand } from '../types'

export const command:ICommand = {
  name: 'forgetme',
  examples: [
    '/forgetme'
  ],
  description: 'exercise your right to be forgotten',
  async exec ({ commander, req }) {
    const { productsAPI } = commander
    await productsAPI.forgetUser(req)
  }
}
