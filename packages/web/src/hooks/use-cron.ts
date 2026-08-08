import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useCronJobs() {
  return useQuery({
    queryKey: queryKeys.cron.all,
    queryFn: () => api.getCronJobs(),
  })
}
