import { classifyError } from "../errorHandling";

describe("classifyError", () => {
  it("classifies a body-parser JSON parse failure as a client error", () => {
    const err = {
      expose: true,
      statusCode: 400,
      status: 400,
      type: "entity.parse.failed",
    };

    const result = classifyError(err);

    expect(result).toEqual({
      status: 400,
      isClientError: true,
      label: "Bad Request",
    });
  });

  it("uses the accurate status text for other 4xx errors", () => {
    expect(classifyError({ status: 404 })).toEqual({
      status: 404,
      isClientError: true,
      label: "Not Found",
    });

    expect(classifyError({ statusCode: 429 })).toEqual({
      status: 429,
      isClientError: true,
      label: "Too Many Requests",
    });
  });

  it("treats unclassified/5xx errors as server errors defaulting to 500", () => {
    expect(classifyError(new Error("boom"))).toEqual({
      status: 500,
      isClientError: false,
      label: "Internal server error",
    });

    expect(classifyError({ status: 503 })).toEqual({
      status: 503,
      isClientError: false,
      label: "Internal server error",
    });
  });

  it("falls back to 500 for invalid or out-of-range status values", () => {
    expect(classifyError({ status: "400 Bad Request" })).toMatchObject({
      status: 500,
      isClientError: false,
    });

    expect(classifyError({ status: 4004 })).toMatchObject({
      status: 500,
      isClientError: false,
    });

    expect(classifyError({ status: NaN })).toMatchObject({
      status: 500,
      isClientError: false,
    });

    expect(classifyError(null)).toMatchObject({
      status: 500,
      isClientError: false,
    });
  });
});
