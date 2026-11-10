param(
  [string]$Folder = "C:\Users\verga\Desktop\DevTrace\docs\linkedin-screenshots",
  [int]$IntervalMs = 4500
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$files = Get-ChildItem -Path $Folder -Filter *.png | Where-Object { $_.Name -notmatch "DevTrace-Feature" } | Select-Object -ExpandProperty FullName
if ($files.Count -eq 0) {
  Write-Error "No PNG files found in $Folder"
  exit 1
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "DevTrace Slideshow Display"
$form.Width = 1000
$form.Height = 650
$form.StartPosition = "Manual"
$form.Left = 50
$form.Top = 50
$form.BackColor = [System.Drawing.Color]::FromArgb(28, 28, 30)

$pictureBox = New-Object System.Windows.Forms.PictureBox
$pictureBox.Dock = [System.Windows.Forms.DockStyle]::Fill
$pictureBox.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
$form.Controls.Add($pictureBox)

$index = 0
$pictureBox.Image = [System.Drawing.Image]::FromFile($files[$index])

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $IntervalMs
$timer.Add_Tick({
    $script:index = ($script:index + 1) % $files.Count
    $old = $pictureBox.Image
    $pictureBox.Image = [System.Drawing.Image]::FromFile($files[$script:index])
    if ($old) { $old.Dispose() }
})
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
