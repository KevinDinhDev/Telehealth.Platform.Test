const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const mysql = require('mysql');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const fs = require('fs');
const axios = require('axios');
const util = require('util');

const app = express();
const port = 3000;

const bcryptHash = util.promisify(bcrypt.hash);


  
// something lara taught me (READ ON IT)
app.use(express.static("public"));

// Add this middleware to parse JSON requests
app.use(express.json());

// Load configuration from a single JSON file
const config = JSON.parse(fs.readFileSync('../config.json'));

// Create MySQL connection pool
const pool = mysql.createPool({
    connectionLimit: 10,
    host: config.mysql.host,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: config.email.user,
        pass: config.email.pass,
    },
});

// Zoom app credentials
const clientId = config.zoom.clientId;
const clientSecret = config.zoom.clientSecret;
const redirectUri = config.zoom.redirectUri;

// Token Chest
//Insert.Read.Delete
const tokens = {};



// Verify JWT middleware
function verifyToken(req, res, next) {
    const token = req.headers['authorization'] && req.headers['authorization'].split(' ')[1];

    if (!token) {
        return res.status(403).json({ error: 'Token not provided' });
    }

    console.log('Received Token:', token);

    jwt.verify(token, config.jwt.secret, (err, decoded) => {
        if (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token has expired' });
            } else {
                console.error('JWT Verification Error:', err.message);
                return res.status(401).json({ error: 'Failed to authenticate token' });
            }
        }

        console.log('Decoded Token:', decoded); // Logs decoded payload

        req.user = decoded;
        next();
    });
}

// Endpoint to check if a username is already taken
app.get('/check-username', (req, res) => {
    const requestedUsername = req.query.username;

    // Use connection from pool
    pool.getConnection((connectionError, connection) => {
        if (connectionError) {
            console.error('Error getting MySQL connection:', connectionError);
            return res.status(500).json({ error: 'Internal Server Error' });
        }

        // Check if the requested username is already taken
        const isTakenQuery = 'SELECT * FROM users WHERE username = ?';
        connection.query(isTakenQuery, [requestedUsername], (queryError, results) => {
            connection.release();

            if (queryError) {
                console.error('Error checking username:', queryError);
                return res.status(500).json({ error: 'Error checking username' });
            }

            // If results array is not empty, the username is already taken
            const isTaken = results.length > 0;
            res.json({ isTaken });
        });
    });
});

// Registering a patient
app.post('/register-patient', async (req, res) => {
    console.log('Request Body:', req.body);
    try {
        const { username, password, role, firstName, lastName, patientCondition, phoneNumber, email, address, city, state, zipCode } = req.body;

        // Hash the password asynchronously
        const hashedPassword = await bcrypt.hash(password, 10);

        // Use connection from pool
        pool.getConnection((connectionError, connection) => {
            if (connectionError) {
                console.error('Error getting MySQL connection:', connectionError);
                return res.status(500).json({ error: 'Internal Server Error' });
            }

            // Insert user into MySQL with hashed password and role
            const userQuery = 'INSERT INTO users (username, password, role) VALUES (?, ?, ?)';
            connection.query(userQuery, [username, hashedPassword, role], (userInsertError, userResult) => {
                if (userInsertError) {
                    connection.release();
                    console.error('Error registering user:', userInsertError);
                    return res.status(500).json({ error: 'Error registering user' });
                }

                // Insert patient into MySQL with additional details
                const patientQuery = 'INSERT INTO patients (user_id, first_name, last_name, patient_condition, phone_number, email, address, city, state, zip_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
                const userId = userResult.insertId;
                connection.query(patientQuery, [userId, firstName, lastName, patientCondition, phoneNumber, email, address, city, state, zipCode], (patientInsertError) => {
                    connection.release();

                    if (patientInsertError) {
                        console.error('Error registering patient:', patientInsertError);
                        return res.status(500).json({ error: 'Error registering patient' });
                    }

                    return res.json({ message: 'Patient registered successfully' });
                });
            });
        });
    } catch (error) {
        console.error('Unexpected error during patient registration:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});


// Registering a doctor
app.post('/register-doctor', (req, res) => {
    const { username, password, role, firstName, lastName, specialty, npi, email, officeNumber } = req.body;

    // Hash the password
    bcrypt.hash(password, 10, (err, hashedPassword) => {
        if (err) {
            console.error('Error hashing password:', err);
            return res.status(500).json({ error: 'Internal Server Error' });
        }

        // Use connection from pool
        pool.getConnection((connectionError, connection) => {
            if (connectionError) {
                console.error('Error getting MySQL connection:', connectionError);
                return res.status(500).json({ error: 'Internal Server Error' });
            }

            // Insert user into MySQL with hashed password, role
            const userQuery = 'INSERT INTO users (username, password, role) VALUES (?, ?, ?)';
            connection.query(userQuery, [username, hashedPassword, role], (userInsertError, userResult) => {
                if (userInsertError) {
                    connection.release();
                    console.error('Error registering user:', userInsertError);
                    return res.status(500).json({ error: 'Error registering user' });
                }

                const userId = userResult.insertId;

                // Insert doctor into MySQL with additional details
                const doctorQuery = 'INSERT INTO doctors (user_id, first_name, last_name, specialty, npi, email, office_number) VALUES (?, ?, ?, ?, ?, ?, ?)';
                connection.query(doctorQuery, [userId, firstName, lastName, specialty, npi, email, officeNumber], (doctorInsertError) => {
                    connection.release();

                    if (doctorInsertError) {
                        console.error('Error registering doctor:', doctorInsertError);
                        return res.status(500).json({ error: 'Error registering doctor' });
                    }

                    return res.json({ message: 'Doctor registered successfully' });

                });
            });
        });
    });
});


// Login route
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    // Use connection from pool
    pool.getConnection((connectionError, connection) => {
        if (connectionError) {
            console.error('Error getting MySQL connection:', connectionError);
            res.status(500).json({ error: 'Internal Server Error' });
            return;
        }

        // Find the user by username
        const query = 'SELECT u.user_id, u.username, u.password, u.role, ' +
            'CASE ' +
            'WHEN u.role = "patient" THEN p.first_name ' +
            'WHEN u.role = "doctor" THEN d.first_name ' +
            'ELSE NULL ' +
            'END AS first_name ' +
            'FROM users u ' +
            'LEFT JOIN patients p ON u.user_id = p.user_id ' +
            'LEFT JOIN doctors d ON u.user_id = d.user_id ' +
            'WHERE u.username = ?';
        connection.query(query, [username], (queryError, results) => {
            connection.release();

            if (queryError) {
                console.error('Error finding user:', queryError);
                res.status(500).json({ error: 'Error finding user' });
            } else {
                console.log('Query Results:', results); // Log query results

                if (results.length > 0) {
                    // Compare passwords
                    const hashedPassword = results[0].password;
                    const userRole = results[0].role;
                    const userFirstName = results[0].first_name; // Retrieve first name
                    
                    console.log('Retrieved User Data:', { username, userRole, userFirstName }); // Log retrieved user data

                    bcrypt.compare(password, hashedPassword, (compareError, passwordMatch) => {
                        if (compareError) {
                            console.error('Error comparing passwords:', compareError);
                            res.status(500).json({ error: 'Internal Server Error' });
                        } else if (passwordMatch) {
                            // Create and send a JWT token along with user's first name
                            const token = jwt.sign({ username, role: userRole, firstName: userFirstName }, config.jwt.secret);
                            tokens.username=token;
                            console.log('Received Token:', token); // Log received token
                            res.json({ token: token, firstName: userFirstName }); // Include first name in the response
                        } else {
                            res.status(401).json({ error: 'Invalid credentials' });
                        }
                    });
                } else {
                    res.status(401).json({ error: 'Invalid credentials' });
                }
            }
        });
    });
});


// Sign-out for Token Deletion (unfinished 3/8 12:16am)
app.post('/sign-out', verifyToken, (req, res) => {
    const { username, token } = req.body;

})

// Protected route example (requires a valid JWT)
app.get('/dashboard', verifyToken, (req, res) => {
    console.log('Decoded Token:', req.user);
    const userRole = req.user.role;

    if (userRole === 'doctor') {
        // Doctor-specific functionality
        return res.json({ message: 'Welcome, Doctor!' });
    } else if (userRole === 'patient') {
        // Patient-specific functionality
        return res.json({ message: 'Welcome, Patient!' });
    } else {
        return res.status(403).json({ error: 'Unauthorized' });
    }
});

       
// Schedule appointment route
app.post('/schedule-appointment', verifyToken, (req, res) => {
    const { date, time, participants, doctorId, patientId, scheduledDate, updatedDate } = req.body;
    const userId = req.user.id; // Assuming your users table has an 'id' property

    // Validate input
    if (!date || !time || !participants || !doctorId || !patientId) {
        return res.status(400).json({ error: 'Missing required fields for scheduling appointment' });
    }

    // Use connection from pool
    pool.getConnection((connectionError, connection) => {
        if (connectionError) {
            console.error('Error getting MySQL connection:', connectionError);
            return res.status(500).json({ error: 'Internal Server Error' });
        }

        // Check for scheduling conflicts
        const conflictQuery = 'SELECT * FROM appointments WHERE date = ? AND time = ? AND doctor_id = ?';
        connection.query(conflictQuery, [date, time, doctorId], (conflictError, conflictResults) => {
            if (conflictError) {
                connection.release();
                console.error('Error checking for scheduling conflicts:', conflictError);
                return res.status(500).json({ error: 'Error checking for scheduling conflicts' });
            }

            if (conflictResults.length > 0) {
                connection.release();
                return res.status(409).json({ error: 'Scheduling conflict: Appointment already exists at this date and time' });
            }

            // No scheduling conflicts, proceed with appointment scheduling

            // Insert appointment into MySQL
            const query = 'INSERT INTO appointments (date, time, patient_id, doctor_id, scheduled_date) VALUES (?, ?, ?, ?, ?)';
            connection.query(query, [date, time, patientId, doctorId, scheduledDate], (insertError, result) => {
                if (insertError) {
                    connection.release();
                    console.error('Error scheduling appointment:', insertError);
                    return res.status(500).json({ error: 'Error scheduling appointment' });
                }

                // Associate the appointment with the patient who scheduled it
                const appointmentId = result.insertId;

                // Logic to associate the appointment with the patient in a separate table or update the users table
                const associateQuery = 'INSERT INTO user_appointments (user_id, appointment_id) VALUES (?, ?)';
                const patientUserIdQuery = 'SELECT user_id FROM patients WHERE patient_id = ?';

                connection.query(patientUserIdQuery, [patientId], (userIdError, userIdResult) => {
                    if (userIdError) {
                        connection.release();
                        console.error('Error retrieving patient user_id:', userIdError);
                        return res.status(500).json({ error: 'Error retrieving patient user_id' });
                    }

                    const patientUserId = userIdResult[0].user_id;

                    connection.query(associateQuery, [patientUserId, appointmentId], (associateError) => {
                        // Retrieve patient and doctor information for sending notifications
                        const patientInfoQuery = 'SELECT * FROM patients WHERE patient_id = ?';
                        const doctorInfoQuery = 'SELECT * FROM doctors WHERE doctor_id = ?';

                        connection.query(patientInfoQuery, [patientId], (patientInfoError, patientInfoResult) => {
                            if (patientInfoError || patientInfoResult.length === 0) {
                                connection.release();
                                console.error('Error retrieving patient information:', patientInfoError);
                                return res.status(500).json({ error: 'Error retrieving patient information' });
                            }

                            const patientInfo = patientInfoResult[0];

                            connection.query(doctorInfoQuery, [doctorId], (doctorInfoError, doctorInfoResult) => {
                                connection.release();

                                if (doctorInfoError || doctorInfoResult.length === 0) {
                                    console.error('Error retrieving doctor information:', doctorInfoError);
                                    return res.status(500).json({ error: 'Error retrieving doctor information' });
                                }

                                const doctorInfo = doctorInfoResult[0];

                                // Send email notification to patient
                                sendAppointmentNotification(patientInfo.email, date, time, true);

                                // Send comprehensive email notification to doctor
                                sendAppointmentNotification(doctorInfo.email, date, time, false, {
                                    firstName: patientInfo.first_name,
                                    lastName: patientInfo.last_name,
                                    email: patientInfo.email,
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// Function to send email notification
function sendAppointmentNotification(email, date, time, isPatient, patientInfo = null) {
    let mailOptions;

    if (isPatient) {
        // Patient notification
        mailOptions = {
            from: 'telehealth.platform.health@gmail.com',
            to: email,
            subject: 'Appointment Scheduled - Telehealth Platform',
            text: `Your appointment is scheduled for ${date} at ${time}. Please log in to the Telehealth Platform for further details.`,
        };
    } else {
        // Doctor notification
        mailOptions = {
            from: 'telehealth.platform.health@gmail.com',
            to: email,
            subject: 'New Appointment Scheduled - Telehealth Platform',
            text: `A new appointment is scheduled for your attention:\n\nPatient Information:\nName: ${patientInfo.firstName} ${patientInfo.lastName}\nEmail: ${patientInfo.email}\n\nAppointment Details:\nDate: ${date}\nTime: ${time}\n\nPlease log in to the Telehealth Platform for further details.`,
        };
    }

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Error sending email:', error);
        } else {
            console.log('Email sent:', info.response);
        }
    });
}

// Update appointment route
app.put('/update-appointment', verifyToken, (req, res) => {
    const { appointmentId, newTime, updatedDate } = req.body;

    // Validate input
    if (!appointmentId || !newTime || !updatedDate) {
        return res.status(400).json({ error: 'Missing required fields for updating appointment' });
    }

    // Use connection from pool
    pool.getConnection((connectionError, connection) => {
        if (connectionError) {
            console.error('Error getting MySQL connection:', connectionError);
            return res.status(500).json({ error: 'Internal Server Error' });
        }

        // Retrieve the patient's and doctor's information for sending notifications
        const appointmentInfoQuery = `
            SELECT
                p.email as patient_email,
                d.email as doctor_email,
                p.first_name as patient_first_name,
                p.last_name as patient_last_name
            FROM patients p
            JOIN appointments a ON p.patient_id = a.patient_id
            JOIN doctors d ON d.doctor_id = a.doctor_id
            WHERE a.appointment_id = ?
        `;

        console.log('Appointment ID:', appointmentId);

        connection.query(appointmentInfoQuery, [appointmentId], (infoError, infoResult) => {
            if (infoError) {
                connection.release();
                console.error('Error retrieving appointment information:', infoError);
                return res.status(500).json({ error: 'Error retrieving appointment information' });
            }

            console.log('Query Result:', infoResult);

            if (infoResult.length > 0) {
                const patientEmail = infoResult[0].patient_email;
                const doctorEmail = infoResult[0].doctor_email;
                const patientFirstName = infoResult[0].patient_first_name;
                const patientLastName = infoResult[0].patient_last_name;

                // Update appointment in MySQL
                const updateQuery = 'UPDATE appointments SET time = ?, updated_date = ? WHERE appointment_id = ?';
                connection.query(updateQuery, [newTime, updatedDate, appointmentId], (updateError, result) => {
                    connection.release();

                    if (updateError) {
                        console.error('Error updating appointment:', updateError);
                        return res.status(500).json({ error: 'Error updating appointment' });
                    }

                    if (result.affectedRows === 0) {
                        console.error('Appointment not found for update:', appointmentId);
                        return res.status(404).json({ error: 'Appointment not found for update' });
                    }

                    console.log('Appointment updated successfully');

                    // Send email notifications
                    sendUpdateNotification(patientEmail, newTime, updatedDate, 'Patient');
                    sendUpdateNotification(doctorEmail, newTime, updatedDate, 'Doctor', patientFirstName, patientLastName, { patientEmail, appointmentId });

                    return res.json({ message: 'Appointment updated successfully' });
                });
            } else {
                connection.release();
                console.error('Patient or doctor not found for the appointment:', appointmentId);
                return res.status(404).json({ error: 'Patient or doctor not found for the appointment' });
            }
        });
    });
});

// Function to send email notification for appointment updates
function sendUpdateNotification(email, newTime, updatedDate, recipientType, patientFirstName = null, patientLastName = null, additionalInfo = null) {
    let mailOptions;

    if (recipientType === 'Patient') {
        mailOptions = {
            from: 'telehealth.platform.health@gmail.com',
            to: email,
            subject: `Appointment Update - Telehealth Platform (${recipientType})`,
            text: `Your appointment has been updated. The new time is ${newTime} on ${updatedDate}. Log in to the Telehealth Platform for more details.`,
        };
    } else if (recipientType === 'Doctor') {
        const patientEmail = additionalInfo && additionalInfo.patientEmail;
        const appointmentId = additionalInfo && additionalInfo.appointmentId;
        mailOptions = {
            from: 'telehealth.platform.health@gmail.com',
            to: email,
            subject: `Appointment Update - Telehealth Platform (${recipientType})`,
            text: `The appointment with patient ${patientFirstName} ${patientLastName} has been updated. The new time is ${newTime} on ${updatedDate}. Log in to the Telehealth Platform for more details.\nPatient Email: ${patientEmail}\nAppointment ID: ${appointmentId}`,
        };
    }

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error(`Error sending ${recipientType.toLowerCase()} email:`, error);
        } else {
            console.log(`${recipientType} Email sent:`, info.response);
        }
    });
}



// Delete appointment route
app.delete('/delete-appointment', verifyToken, (req, res) => {
    const { appointment_id } = req.body;
    const userRole = req.user.role;

    // Check user role
    if (userRole !== 'patient' && userRole !== 'doctor') {
        return res.status(403).json({ error: 'Unauthorized: Only patients and doctors can delete appointments' });
    }

    // Use connection from pool
    pool.getConnection((connectionError, connection) => {
        if (connectionError) {
            console.error('Error getting MySQL connection:', connectionError);
            return res.status(500).json({ error: 'Internal Server Error' });
        }

        // Retrieve appointment details before deletion
        const getAppointmentQuery = 'SELECT * FROM appointments WHERE appointment_id = ?';
        connection.query(getAppointmentQuery, [appointment_id], (getAppointmentError, appointmentResult) => {
            if (getAppointmentError) {
                connection.release();
                console.error('Error retrieving appointment details:', getAppointmentError);
                return res.status(500).json({ error: 'Error retrieving appointment details' });
            }

            if (appointmentResult.length === 0) {
                connection.release();
                return res.status(404).json({ error: 'Appointment not found' });
            }

            const { date, time, doctor_id, patient_id } = appointmentResult[0];

            // Delete appointment from MySQL
            const deleteQuery = 'DELETE FROM appointments WHERE appointment_id = ?';
            connection.query(deleteQuery, [appointment_id], (deleteError, result) => {
                connection.release();

                if (deleteError) {
                    console.error('Error deleting appointment:', deleteError);
                    return res.status(500).json({ error: 'Error deleting appointment' });
                }

                if (result.affectedRows === 0) {
                    // No rows were affected, meaning no appointment was found with the given ID
                    return res.status(404).json({ error: 'Appointment not found' });
                }

                console.log('Appointment deleted successfully');

                // Retrieve doctor's email
                const emailQueryDoctor = 'SELECT email FROM doctors WHERE doctor_id = ?';
                connection.query(emailQueryDoctor, [doctor_id], (doctorError, doctorResult) => {
                    if (doctorError) {
                        console.error('Error retrieving doctor email:', doctorError);
                        return res.status(500).json({ error: 'Error retrieving doctor email' });
                    }

                    if (doctorResult.length === 0) {
                        console.error('Doctor email not found');
                        return res.status(500).json({ error: 'Doctor email not found' });
                    }

                    const doctorEmail = doctorResult[0].email;

                    // Retrieve patient's email
                    const emailQueryPatient = 'SELECT email FROM patients WHERE patient_id = ?';
                    connection.query(emailQueryPatient, [patient_id], (patientError, patientResult) => {
                        if (patientError) {
                            console.error('Error retrieving patient email:', patientError);
                            return res.status(500).json({ error: 'Error retrieving patient email' });
                        }

                        if (patientResult.length === 0) {
                            console.error('Patient email not found');
                            return res.status(500).json({ error: 'Patient email not found' });
                        }

                        const patientEmail = patientResult[0].email;

                        // Send email notification to both doctor and patient
                        const subject = `Appointment Cancellation - Telehealth Platform`;
                        let text = `Your appointment scheduled for ${date} at ${time} has been cancelled. We apologize for any inconvenience.`;

                        sendCancellationNotification(doctorEmail, subject, text, 'Doctor', patientEmail, appointment_id, date, time);
                        sendCancellationNotification(patientEmail, subject, text, 'Patient', null, null, date, time);

                        return res.json({ message: 'Appointment deleted successfully' });
                    });
                });
            });
        });
    });
});

// Function to send email for appointment cancellation
function sendCancellationNotification(email, subject, text, recipientType, patientEmail = null, appointmentId = null, date, time) {
    const mailOptions = {
        from: 'telehealth.platform.health@gmail.com',
        to: email,
        subject: `${subject} - Telehealth Platform (${recipientType})`,
        text,
    };

    if (recipientType === 'Doctor') {
        mailOptions.text += `\nAppointment Details:\nDate: ${date}\nTime: ${time}\nPatient Email: ${patientEmail}\nAppointment ID: ${appointmentId}`;
    }

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error(`Error sending ${recipientType.toLowerCase()} email:`, error);
        } else {
            console.log(`${recipientType} Email sent:`, info.response);
        }
    });
}

// Callback route
app.get('/zoom/oauth/callback', async (req, res) => {
    try {
      const code = req.query.code;
  
      // Exchange authorization code for access token
      const tokenResponse = await axios.post('https://zoom.us/oauth/token', null, {
        params: {
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        },
      });
  
      // Store the access token securely
      const accessToken = tokenResponse.data.access_token;
  
      // Now I can use accessToken to make Zoom API requests
  
      res.send('Authorization successful!');
    } catch (error) {
      console.error('Error during OAuth callback:', error);
      res.status(500).send('Internal Server Error');
    }
  });

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
