import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useOrg() {
  return useQuery({
    queryKey: queryKeys.org.all,
    queryFn: () => api.getOrg(),
  })
}
