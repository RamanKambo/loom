<#
.SYNOPSIS
Dispatches a paid order to fulfillment by creating a pending shipment.

.DESCRIPTION
Test fixture for the generated Routines.Contract.Tests.ps1: its param block
matches the sample contract of routine fulfillment.rb_dispatch (OrderId
mandatory string, InitialState optional with the shipment.state values,
Notify optional switch). The contract check parses this file and never runs it.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNull()]
    [string] $OrderId,

    [Parameter()]
    [ValidateNotNull()]
    [ValidateSet('pending', 'dispatched', 'delivered')]
    [string] $InitialState = 'pending',

    [ValidateNotNull()]
    [switch] $Notify
)

[pscustomobject]@{
    shipment_id = [guid]::NewGuid().ToString()
    state       = $InitialState
}
