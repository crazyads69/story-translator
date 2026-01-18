import nock from "nock";
import { afterEach, beforeAll } from "vitest";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

