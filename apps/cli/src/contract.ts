import { completers as taskCompleters, formatters as taskFormatters } from '@tania/task/cli'
import { contract as taskContract } from '@tania/task/contract'
import { formatters as workbenchFormatters } from '@tania/workbench/cli'
import { contract as workbenchContract } from '@tania/workbench/contract'

export const contract = { workbench: workbenchContract, task: taskContract }

export const formatters = { workbench: workbenchFormatters, task: taskFormatters }

export const completers = { task: taskCompleters }
