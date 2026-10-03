// Conformance fixture: implements the sample contract's ordering types exactly, so the generated
// ContractTests.cs passes against it. The violating copy differs only in Order.Total.
using System.Text.Json.Serialization;

namespace Ordering.Contracts;

// Member names are the contract's values, so they serialize unchanged and an unknown value is rejected.
[JsonConverter(typeof(JsonStringEnumConverter<OrderStatus>))]
public enum OrderStatus
{
    placed,
    paid,
    shipped,
    cancelled,
}

public sealed class Order
{
    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("status")]
    public required OrderStatus Status { get; set; }

    // A decimal travels as a string on the wire, so no digit is lost to binary floating point.
    [JsonPropertyName("total")]
    [JsonNumberHandling(JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString)]
    public required decimal Total { get; set; }

    [JsonPropertyName("note")]
    public string? Note { get; set; }
}

public sealed class OrderRequest
{
    [JsonPropertyName("id")]
    public required string Id { get; set; }

    [JsonPropertyName("total")]
    [JsonNumberHandling(JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString)]
    public required decimal Total { get; set; }

    [JsonPropertyName("note")]
    public string? Note { get; set; }
}

public sealed class OrderResponse
{
    [JsonPropertyName("id")]
    public required string Id { get; set; }

    [JsonPropertyName("status")]
    public required OrderStatus Status { get; set; }

    [JsonPropertyName("total")]
    [JsonNumberHandling(JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString)]
    public required decimal Total { get; set; }

    [JsonPropertyName("note")]
    public string? Note { get; set; }
}
