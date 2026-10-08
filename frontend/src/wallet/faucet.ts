/**
 * Accepting an incoming DevNet faucet transfer (Token Standard). The frontend builds the command
 * itself, not the backend: only a transfer known to the wallet is accepted, checked by
 * the same verifyPrepared (intent 'accept-transfer').
 */
import type { PreparedCommand } from '@lending/shared'
import { TRANSFER_INSTRUCTION } from './verify.ts'

export function acceptTransferCommand(party: string, offerCid: string): PreparedCommand {
  return {
    actAs: [party],
    commands: [
      {
        ExerciseCommand: {
          templateId: TRANSFER_INSTRUCTION,
          contractId: offerCid,
          choice: 'TransferInstruction_Accept',
          choiceArgument: {
            extraArgs: { context: { values: {} }, meta: { values: {} } },
          },
        },
      },
    ],
    disclosedContracts: [],
    // the server needs no seal: the node wallet signs and submits the command
    seal: '',
  }
}
