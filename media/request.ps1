# Only the extension's fixed script is executed. Request content and credentials
# arrive over stdin, never in process arguments or a generated script.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $request = [System.Net.HttpWebRequest]::Create([string]$payload.url)
    $request.Method = 'POST'
    $request.ContentType = 'text/xml; charset=utf-8'
    $request.Headers.Add('SOAPAction', '"' + [string]$payload.action + '"')
    $request.AllowAutoRedirect = $false
    $request.Timeout = [int]$payload.timeoutSeconds * 1000
    $request.ReadWriteTimeout = $request.Timeout
    if ($payload.auth -eq 'windows') {
        $request.UseDefaultCredentials = $true
    } else {
        if ([string]$payload.username -match '^([^\\]+)\\(.+)$') {
            $credential = New-Object System.Net.NetworkCredential($Matches[2], [string]$payload.password, $Matches[1])
        } else {
            $credential = New-Object System.Net.NetworkCredential([string]$payload.username, [string]$payload.password)
        }
        # Register the password for NTLM/Negotiate only, so a server answering with a
        # Basic challenge cannot receive it in clear text.
        $cache = New-Object System.Net.CredentialCache
        foreach ($scheme in 'NTLM', 'Negotiate') { $cache.Add($request.RequestUri, $scheme, $credential) }
        $request.Credentials = $cache
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$payload.body)
    $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    try { $response = $request.GetResponse() }
    catch [System.Net.WebException] {
        $response = $_.Exception.Response
        if ($null -eq $response) { throw }
    }
    if ($response.ContentLength -gt 104857600) { throw 'Response too large' }
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $buffer = New-Object char[] 8192
    $content = New-Object System.Text.StringBuilder
    while (($count = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if (($content.Length + $count) -gt 104857600) { throw 'Response too large' }
        [void]$content.Append($buffer, 0, $count)
    }
    $reader.Close()
    @{ status = [int]$response.StatusCode; body = $content.ToString() } | ConvertTo-Json -Compress -Depth 4
    $response.Close()
} catch {
    # Avoid printing server output, input XML, credentials or exception text.
    [Console]::Error.WriteLine('Windows SSRS transport failed. Check connectivity, certificate trust, authentication and PowerShell policy.')
    exit 1
}
