<?php
$secret = $_REQUEST['secret'];
$truesecret = "your-secret";
if ($secret !== $truesecret) {
	echo json_encode (false);
	exit;
}

$to = $_REQUEST['mail_to'];
$subject = $_REQUEST['subject'];
$message = '<html><body>' . $_REQUEST['body'] . '</body></html>';

$headers  = 'MIME-Version: 1.0' . "\r\n";
$headers .= 'Content-type: text/html; charset=iso-8859-1' . "\r\n";
$headers .= 'From: doorsheet@rochesterkinksociety.com' . "\r\n" .
            'Reply-To: rkscrm@rochesterkinksociety.com' . "\r\n" .
            'X-Mailer: PHP/' . phpversion();


$return = mail ( $to , $subject , $message, $headers);
echo json_encode ($return);
?>
