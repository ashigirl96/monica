import { completers as jobCompleters, formatters as jobFormatters } from '@monica/job/cli'
import { contract as jobContract } from '@monica/job/contract'
import { completers as taskCompleters, formatters as taskFormatters } from '@monica/task/cli'
import { contract as taskContract } from '@monica/task/contract'
import { formatters as workbenchFormatters } from '@monica/workbench/cli'
import { contract as workbenchContract } from '@monica/workbench/contract'

export const contract = { workbench: workbenchContract, task: taskContract, job: jobContract }

export const formatters = {
  workbench: workbenchFormatters,
  task: taskFormatters,
  job: jobFormatters,
}

export const completers = { task: taskCompleters, job: jobCompleters }
