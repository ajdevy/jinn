import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useSkills() {
  return useQuery({
    queryKey: queryKeys.skills.all,
    queryFn: () => api.getSkills(),
  })
}
