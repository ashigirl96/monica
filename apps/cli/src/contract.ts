import { completers as jobCompleters, formatters as jobFormatters } from '@tania/job/cli'
import { contract as jobContract } from '@tania/job/contract'
import { completers as taskCompleters, formatters as taskFormatters } from '@tania/task/cli'
import { contract as taskContract } from '@tania/task/contract'
import { formatters as workbenchFormatters } from '@tania/workbench/cli'
import { contract as workbenchContract } from '@tania/workbench/contract'

export const contract = { workbench: workbenchContract, task: taskContract, job: jobContract }

export const formatters = {
  workbench: workbenchFormatters,
  task: taskFormatters,
  job: jobFormatters,
}

export const completers = { task: taskCompleters, job: jobCompleters }
