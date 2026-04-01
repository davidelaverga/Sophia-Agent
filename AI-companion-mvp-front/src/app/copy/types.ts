import type { copy } from "./locales/en"

type DeepStringify<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly DeepStringify<U>[]
    : T extends (infer U)[]
      ? DeepStringify<U>[]
      : T extends object
        ? { [K in keyof T]: DeepStringify<T[K]> }
        : T

// Source of truth structure is English, but leaf values are strings (not literals)
export type CopyStructure = DeepStringify<typeof copy>

type StringLeaves<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends readonly unknown[]
      ? never
      : T[K] extends object
        ? `${K}.${StringLeaves<T[K]>}`
        : never
}[keyof T & string]

export type CopyKey = StringLeaves<CopyStructure>

export type InterpolationValues = Record<string, string | number>
