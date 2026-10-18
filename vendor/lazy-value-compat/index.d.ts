export class Lazy<T> {
  constructor(initialize: () => Promise<T>)
  readonly hasValue: boolean
  get value(): Promise<T>
  set value(next: Promise<T>)
}
