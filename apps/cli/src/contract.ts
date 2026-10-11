import { completers as jobCompleters, formatters as jobFormatters } from '@monica/job/cli'
import { contract as jobContract } from '@monica/job/contract'
import { completers as taskCompleters, formatters as taskFormatters } from '@monica/task/cli'
import { contract as taskContract } from '@monica/task/contract'
import { formatters as usageFormatters } from '@monica/usage/cli'
import { contract as usageContract } from '@monica/usage/contract'
import { formatters as workbenchFormatters } from '@monica/workbench/cli'
import { contract as workbenchContract } from '@monica/workbench/contract'

export const contract = {
  workbench: workbenchContract,
  task: taskContract,
  job: jobContract,
  usage: usageContract,
}

export const formatters = {
  workbench: workbenchFormatters,
  task: taskFormatters,
  job: jobFormatters,
  usage: usageFormatters,
}

export const completers = { task: taskCompleters, job: jobCompleters }
