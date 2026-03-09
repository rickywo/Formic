import { useQuery, useMutation, type UseQueryResult, type UseMutationResult } from '@tanstack/react-query';
import axios, { type AxiosError } from 'axios';
import type { ApiResponse } from '@/types';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 10000,
});

export function useApiGet<T>(
  key: string[],
  endpoint: string,
  enabled = true
): UseQueryResult<ApiResponse<T>, AxiosError> {
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const response = await api.get<ApiResponse<T>>(endpoint);
      return response.data;
    },
    enabled,
  });
}

export function useApiPost<T, TVariables>(
  endpoint: string
): UseMutationResult<ApiResponse<T>, AxiosError, TVariables> {
  return useMutation({
    mutationFn: async (data: TVariables) => {
      const response = await api.post<ApiResponse<T>>(endpoint, data);
      return response.data;
    },
  });
}
