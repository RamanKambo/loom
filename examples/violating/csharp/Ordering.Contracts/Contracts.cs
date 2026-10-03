// Conformance fixture that VIOLATES the sample contract in exactly one place: Order.Total is a
// double, so the generated ContractTests.cs must fail on it. Everything else matches the contract.
using System.Text.Json.Serialization;

namespace Ordering.Contracts;

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

    [JsonPropertyName("total")]
    [JsonNumberHandling(JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString)]
    public required double Total { get; set; }

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
