/** Test files are out of scope for every arm of benchmark #5. */
export const isTestFile = (path: string) =>
    /\.(test|spec)\.tsx?$|\/(tests?|__tests__|fixtures)\/|setupTests\.ts$|\.d\.ts$/.test(path);
