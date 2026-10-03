import { password, text, isCancel } from '@clack/prompts'

export class PromptCancelledError extends Error {
    constructor() {
        super('Prompt cancelled by user.')
        this.name = 'PromptCancelledError'
    }
}

export async function readlineExistingPassword(prompt: string): Promise<string> {
    const value = await password({ message: prompt, output: process.stderr })
    if (isCancel(value)) throw new PromptCancelledError()
    if (!value) throw new Error('Password cannot be empty.')
    return value
}

export async function readlineNewPassword(): Promise<string> {
    const pw = await password({
        message: 'Enter a password for your tw keystore:',
        output: process.stderr,
    })
    if (isCancel(pw)) throw new PromptCancelledError()
    if (!pw) throw new Error('Password cannot be empty.')

    const confirm = await password({
        message: 'Confirm password:',
        output: process.stderr,
    })
    if (isCancel(confirm)) throw new PromptCancelledError()
    if (pw !== confirm) throw new Error('Passwords do not match.')

    return pw
}

export async function readlineTypedConfirmation(expectedPhrase: string): Promise<boolean> {
    const value = await text({
        message: `Type "${expectedPhrase}" to confirm:`,
        output: process.stderr,
    })
    if (isCancel(value)) throw new PromptCancelledError()
    return value.trim() === expectedPhrase
}
