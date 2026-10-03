export function resolveAgentSendInput(input: {
    channel?: string
    targetOrMessage: string
    messageParts?: string[]
}): { streamId?: string; message: string } {
    if (input.channel) {
        return {
            message: [input.targetOrMessage, ...(input.messageParts ?? [])].join(' '),
        }
    }

    if (!input.messageParts || input.messageParts.length === 0) {
        throw new Error('Message body is required.')
    }

    return {
        streamId: input.targetOrMessage,
        message: input.messageParts.join(' '),
    }
}
