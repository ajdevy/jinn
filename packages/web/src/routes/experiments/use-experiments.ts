import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { ExperimentVerdict } from "./types"

export function useExperiments() {
  return useQuery({
    queryKey: ["experiments"],
    queryFn: () => api.listExperiments(),
    staleTime: 15_000,
  })
}

export function useExperiment(id: string | undefined) {
  return useQuery({
    queryKey: ["experiments", id],
    queryFn: () => api.getExperiment(id!),
    enabled: !!id,
    staleTime: 15_000,
  })
}

// Both mutations invalidate the whole "experiments" key rather than the one
// detail: a reading changes the list's latest value and a verdict changes its
// status, so the list behind the page has to be refetched either way.
export function useRecordReading(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { at: string; metric: string; value: number; note?: string }) =>
      api.recordExperimentReading(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["experiments"] }),
  })
}

export function useConcludeExperiment(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { outcome: ExperimentVerdict["outcome"]; note: string }) =>
      api.concludeExperiment(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["experiments"] }),
  })
}
