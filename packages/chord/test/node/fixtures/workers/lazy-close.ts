// A module the fixture worker imports only in a closer (`WorkerBehaviour.lazyOnClose`): a lazy chunk of its base.

/** What the closer writes once it imported this module. */
export const closed = "lazy chunk loaded at close";
