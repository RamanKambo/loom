// Conformance fixture: implements the sample contract's ordering types exactly, so the generated
// ContractTests.cs passes against it. The violating copy differs only in Order.Total.
using System;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

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
    private string _id = string.Empty;
    [JsonPropertyName("id")]
    public required string Id { get => _id; init => _id = value ?? throw new ArgumentNullException(nameof(Id)); }

    [JsonPropertyName("status")]
    public required OrderStatus Status { get; set; }

    // A decimal travels as a string on the wire, so no digit is lost to binary floating point.
    [JsonPropertyName("total")]
    [JsonNumberHandling(JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString)]
    public required decimal Total { get; set; }

    private string? _note;
    internal bool HasNote { get; private set; }
    [JsonPropertyName("note")]
    public string? Note { get => _note; set { _note = value; HasNote = true; } }
}

public sealed class OrderRequest
{
    private string _id = string.Empty;
    [JsonPropertyName("id")]
    public required string Id { get => _id; set => _id = value ?? throw new ArgumentNullException(nameof(Id)); }

    [JsonPropertyName("total")]
    [JsonNumberHandling(JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString)]
    public required decimal Total { get; set; }

    private string? _note;
    internal bool HasNote { get; private set; }
    [JsonPropertyName("note")]
    public string? Note { get => _note; set { _note = value; HasNote = true; } }
}

public sealed class OrderResponse
{
    private string _id = string.Empty;
    [JsonPropertyName("id")]
    public required string Id { get => _id; set => _id = value ?? throw new ArgumentNullException(nameof(Id)); }

    [JsonPropertyName("status")]
    public required OrderStatus Status { get; set; }

    [JsonPropertyName("total")]
    [JsonNumberHandling(JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString)]
    public required decimal Total { get; set; }

    private string? _note;
    internal bool HasNote { get; private set; }
    [JsonPropertyName("note")]
    public string? Note { get => _note; set { _note = value; HasNote = true; } }
}

// The real serializer preserves absent optional members independently of a present null.
public static class ContractJson
{
    public static JsonSerializerOptions Options { get; } = CreateOptions();
    private static JsonSerializerOptions CreateOptions()
    {
        var resolver = new DefaultJsonTypeInfoResolver();
        resolver.Modifiers.Add(info =>
        {
            foreach (var member in info.Properties)
                if (member.Name == "note") member.ShouldSerialize = (instance, _) => instance switch
                {
                    Order order => order.HasNote,
                    OrderRequest request => request.HasNote,
                    OrderResponse response => response.HasNote,
                    _ => true
                };
        });
        return new JsonSerializerOptions(JsonSerializerDefaults.Web) { TypeInfoResolver = resolver };
    }
}
